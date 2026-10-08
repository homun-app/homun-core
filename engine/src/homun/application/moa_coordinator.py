"""Coordinator for Mixture of Agents (MoA) execution (H24).

Homun ensures that:
1. Advisory reference models run without tools (advisors only advise).
2. The aggregator is the acting model that executes tools and writes the response.
3. Fanout cadence (user_turn, per_iteration, every_n:N) controls advisor invocation frequency.
4. Advisor token usage and costs are truthfully aggregated into the turn's total usage.
5. Optional privacy filtering masks sensitive credentials, emails, and phone numbers.
6. Optional side-channel trace persistence records full turn metrics.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from homun.application.moa_alternation import merge_same_role_messages
from homun.application.moa_contracts import (
    CADENCE_EVERY_N,
    CADENCE_PER_ITERATION,
    CADENCE_USER_TURN,
    MoAAdvisorOutput,
    MoAPreset,
    format_reference_guidance,
    parse_fanout_cadence,
    should_run_advisors,
)
from homun.application.moa_filter import apply_privacy_filter
from homun.application.moa_trace import save_moa_turn_trace
from homun.domain.errors import DomainError
from homun.models.native_turn import NativeMessage
from homun.models.types import UsageEntry

logger = logging.getLogger(__name__)


class MoACoordinatorResult:
    """Outcome of an MoA execution round."""

    def __init__(
        self,
        message: NativeMessage,
        usage: Optional[UsageEntry],
        advisors: List[MoAAdvisorOutput],
        cached_guidance: Optional[str] = None,
    ):
        self.message = message
        self.usage = usage
        self.advisors = advisors
        self.cached_guidance = cached_guidance


class MoACoordinator:
    """Coordinates advisory fan-out and aggregator synthesis for MoA."""

    def __init__(
        self,
        preset: MoAPreset,
        *,
        session_id: Optional[str] = None,
        save_traces: bool = False,
        trace_dir: Optional[str] = None,
    ):
        self.preset = preset
        self.session_id = session_id
        self.save_traces = save_traces
        self.trace_dir = trace_dir
        self.cached_guidance: Optional[str] = None
        self.cadence_mode, self.every_n = parse_fanout_cadence(preset.fanout)

    def execute_turn(
        self,
        messages: List[NativeMessage],
        *,
        tools: Optional[List[Any]],
        iteration_index: int,
        advisor_executor: Callable[[str, str, List[NativeMessage]], Tuple[str, Optional[UsageEntry]]],
        aggregator_executor: Callable[[str, str, List[NativeMessage], Optional[List[Any]]], Tuple[NativeMessage, Optional[UsageEntry]]],
    ) -> MoACoordinatorResult:
        """Execute one step of the agent loop using Mixture of Agents.

        Args:
            messages: Context messages for this turn.
            tools: Tools available to the agent run.
            iteration_index: Index of tool iteration within the current user turn (0, 1, 2...).
            advisor_executor: Callable(provider, model, messages) -> (content, usage) for advisors (NO tools).
            aggregator_executor: Callable(provider, model, messages, tools) -> (message, usage) for aggregator.
        """
        run_advisors = should_run_advisors(
            self.cadence_mode,
            self.every_n,
            iteration_index,
            has_cached_guidance=bool(self.cached_guidance),
        )

        advisor_outputs: List[MoAAdvisorOutput] = []

        if run_advisors and self.preset.reference_models:
            # 1. Fan out to advisory reference models WITHOUT tools
            # Advisors only see user/assistant messages to stay light and avoid prompt bloating
            ref_messages = [
                m for m in messages if m.role in ("user", "assistant", "system")
            ]

            for ref in self.preset.reference_models:
                t0 = time.monotonic()
                try:
                    content, u_entry = advisor_executor(ref.provider, ref.model, ref_messages)
                    duration = round(time.monotonic() - t0, 3)
                    adv = MoAAdvisorOutput(
                        label=ref.display_label,
                        provider=ref.provider,
                        model=ref.model,
                        content=content,
                        input_tokens=u_entry.input_tokens if u_entry else None,
                        output_tokens=u_entry.output_tokens if u_entry else None,
                        estimated_cost=u_entry.estimated_cost if u_entry else None,
                        currency=u_entry.currency if u_entry else "USD",
                        temperature=ref.temperature,
                        duration_seconds=duration,
                    )
                    advisor_outputs.append(adv)
                except DomainError:
                    raise  # Authorization/admission failures must stop the fanout.
                except Exception as exc:
                    logger.warning("MoA advisor %s failed: %s", ref.display_label, exc)

            # Format guidance block and update cache
            guidance = format_reference_guidance(
                advisor_outputs,
                privacy_filter=self.preset.privacy_filter,
            )
            self.cached_guidance = guidance
        else:
            guidance = self.cached_guidance or ""

        # 2. Attach reference guidance to aggregator context
        agg_messages = list(messages)
        if guidance:
            guidance_msg = NativeMessage(
                role="user",
                content=f"Consider these advisory perspectives before choosing actions:\n\n{guidance}",
            )
            agg_messages.append(guidance_msg)
            # Apply reactive role alternation merge for adjacent user messages
            agg_messages = merge_same_role_messages(agg_messages)

        # 3. Call aggregator WITH full tool schemas (the acting model)
        agg = self.preset.aggregator
        agg_msg, agg_usage = aggregator_executor(
            agg.provider,
            agg.model,
            agg_messages,
            tools,
        )

        # 4. Truthful aggregate accounting: combine advisor tokens and cost with aggregator
        total_input_tokens = (agg_usage.input_tokens or 0) if agg_usage else 0
        total_output_tokens = (agg_usage.output_tokens or 0) if agg_usage else 0
        total_cost = (agg_usage.estimated_cost or 0.0) if agg_usage else 0.0

        for adv in advisor_outputs:
            if adv.input_tokens:
                total_input_tokens += adv.input_tokens
            if adv.output_tokens:
                total_output_tokens += adv.output_tokens
            if adv.estimated_cost:
                total_cost += adv.estimated_cost

        from uuid import uuid4
        combined_usage = UsageEntry(
            id=f"moa_usage_{uuid4().hex[:12]}",
            provider_id=agg.provider,
            model_id=agg.model,
            input_tokens=total_input_tokens if total_input_tokens > 0 else None,
            output_tokens=total_output_tokens if total_output_tokens > 0 else None,
            estimated_cost=round(total_cost, 6) if total_cost > 0 else None,
            currency="USD",
            notes=f"MoA [{self.preset.name}] aggregator with {len(advisor_outputs)} advisors",
        )

        # 5. Side-channel trace recording
        if self.save_traces:
            save_moa_turn_trace(
                session_id=self.session_id,
                preset_name=self.preset.name,
                advisors=[a.to_dict() for a in advisor_outputs],
                aggregator={
                    "provider": agg.provider,
                    "model": agg.model,
                    "label": agg.display_label,
                    "input_tokens": agg_usage.input_tokens if agg_usage else None,
                    "output_tokens": agg_usage.output_tokens if agg_usage else None,
                    "tool_calls": [tc.model_dump() for tc in agg_msg.tool_calls],
                },
                trace_dir=self.trace_dir,
                save_traces=True,
            )

        return MoACoordinatorResult(
            message=agg_msg,
            usage=combined_usage,
            advisors=advisor_outputs,
            cached_guidance=self.cached_guidance,
        )
