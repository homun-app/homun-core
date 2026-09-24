"""Auxiliary client routing with audited fallback chains (H38).

Derived from Hermes agent/auxiliary_client.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Manages auxiliary tasks (compression, titling, side questions, vision, verification)
with automatic fallback through a prioritized provider chain, preserving a complete
audit trail of all failover events.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from homun.application.credential_pool import get_credential_pool
from homun.application.provider_contracts import ProviderProfile
from homun.application.provider_registry import get_provider_registry

logger = logging.getLogger(__name__)


@dataclass
class AuxiliaryAuditEntry:
    """Audit record for an auxiliary provider attempt."""

    provider: str
    model: str
    status: str  # "success" | "failed"
    error: Optional[str] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class AuxiliaryCallResult:
    """Result of an auxiliary task execution including audit trail."""

    task: str
    provider_used: str
    model_used: str
    output: str
    fallback_occurred: bool
    fallback_chain_audit: List[Dict[str, Any]]
    tokens_used: int = 0


# Default fallback chains by task category
DEFAULT_AUXILIARY_CHAINS: Dict[str, List[Tuple[str, str]]] = {
    "compression": [
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-3-5-haiku-20241022"),
        ("openrouter", "meta-llama/llama-3.3-70b-instruct"),
        ("ollama", "llama3.2:latest"),
    ],
    "titling": [
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-3-5-haiku-20241022"),
        ("deepseek", "deepseek-chat"),
        ("ollama", "llama3.2:latest"),
    ],
    "vision": [
        ("openai", "gpt-4o-mini"),
        ("gemini", "gemini-2.0-flash"),
        ("anthropic", "claude-3-5-haiku-20241022"),
        ("openrouter", "openai/gpt-4o"),
    ],
    "verification": [
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-3-5-haiku-20241022"),
        ("deepseek", "deepseek-chat"),
        ("ollama", "llama3.2:latest"),
    ],
}


class AuxiliaryRouter:
    """Routes auxiliary calls and executes multi-step fallback with auditing."""

    def __init__(self, custom_chains: Optional[Dict[str, List[Tuple[str, str]]]] = None) -> None:
        self.chains = dict(DEFAULT_AUXILIARY_CHAINS)
        if custom_chains:
            self.chains.update(custom_chains)

    def resolve_chain(
        self,
        task: str,
        preferred_provider: Optional[str] = None,
        preferred_model: Optional[str] = None,
    ) -> List[Tuple[str, str]]:
        """Construct the prioritized candidate list for this task."""
        candidates: List[Tuple[str, str]] = []
        if preferred_provider and preferred_model:
            candidates.append((preferred_provider, preferred_model))

        base_chain = self.chains.get(task, self.chains["compression"])
        for prov, mod in base_chain:
            if (prov, mod) not in candidates:
                candidates.append((prov, mod))
        return candidates

    def execute(
        self,
        task: str,
        prompt: str,
        *,
        executor: Callable[[str, str, str, Dict[str, Any]], Dict[str, Any]],
        preferred_provider: Optional[str] = None,
        preferred_model: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        media: Optional[List[Dict[str, Any]]] = None,
    ) -> AuxiliaryCallResult:
        """Execute auxiliary call along the fallback chain until success.

        ``executor(provider, model, prompt, kwargs)`` -> {"text": str, "tokens": int}
        """
        candidates = self.resolve_chain(task, preferred_provider, preferred_model)
        audit_trail: List[AuxiliaryAuditEntry] = []
        registry = get_provider_registry()
        cred_pool = get_credential_pool()

        for idx, (provider_name, model_name) in enumerate(candidates):
            profile = registry.get_profile(provider_name)
            if profile is None:
                profile = ProviderProfile(name=provider_name)

            # Adapt reasoning and media to this provider's quirks
            extra_body, top_level = profile.adapt_reasoning(reasoning_effort, model=model_name)
            adapted_kwargs = {**top_level}
            if extra_body:
                adapted_kwargs["extra_body"] = extra_body

            if media:
                adapted_media = [profile.adapt_media_fixture(m) for m in media]
                adapted_kwargs["media"] = adapted_media

            # Try to acquire credential if pool has any
            cred = cred_pool.acquire_credential(provider_name)
            if cred:
                adapted_kwargs["api_key"] = cred.secret_value

            try:
                res = executor(provider_name, model_name, prompt, adapted_kwargs)
                out_text = res.get("text", "")
                tokens = res.get("tokens", 0)

                if cred:
                    cred_pool.report_success(provider_name, cred.key_id)

                audit_trail.append(
                    AuxiliaryAuditEntry(
                        provider=provider_name,
                        model=model_name,
                        status="success",
                    )
                )

                fallback_occurred = idx > 0
                return AuxiliaryCallResult(
                    task=task,
                    provider_used=provider_name,
                    model_used=model_name,
                    output=out_text,
                    fallback_occurred=fallback_occurred,
                    fallback_chain_audit=[asdict(e) for e in audit_trail],
                    tokens_used=tokens,
                )

            except Exception as exc:
                err_msg = str(exc)
                logger.warning(
                    "Auxiliary call failed on %s/%s for task '%s': %s",
                    provider_name, model_name, task, err_msg
                )
                if cred:
                    cred_pool.report_failure(provider_name, cred.key_id, err_msg)

                audit_trail.append(
                    AuxiliaryAuditEntry(
                        provider=provider_name,
                        model=model_name,
                        status="failed",
                        error=err_msg,
                    )
                )

        # All candidates exhausted
        raise RuntimeError(
            f"All auxiliary providers exhausted for task '{task}'. "
            f"Audit log: {[asdict(e) for e in audit_trail]}"
        )


_GLOBAL_AUXILIARY_ROUTER: Optional[AuxiliaryRouter] = None


def get_auxiliary_router() -> AuxiliaryRouter:
    global _GLOBAL_AUXILIARY_ROUTER
    if _GLOBAL_AUXILIARY_ROUTER is None:
        _GLOBAL_AUXILIARY_ROUTER = AuxiliaryRouter()
    return _GLOBAL_AUXILIARY_ROUTER


def reset_auxiliary_router() -> None:
    global _GLOBAL_AUXILIARY_ROUTER
    _GLOBAL_AUXILIARY_ROUTER = None
