from homun.application.runtime_calls import complete
"""Accounted model-backed goal verdicts, without tool access or hidden retries."""
import json
from typing import Literal
from pydantic import BaseModel, ConfigDict
from homun.application import budgets
from homun.application.agent_usage import charge, reserve as reserve_usage
from homun.domain.errors import ValidationError
from homun.domain.models import Actor, BudgetCounters
from homun.models.types import ChatMessage
from homun.models.intake import _extract_json_payload


class Verdict(BaseModel):
    model_config = ConfigDict(extra='forbid')
    verdict: Literal['done', 'continue', 'blocked', 'wait']
    reason: str
    wait_seconds: int | None = None


def judge(ctx, run, **inputs):
    from homun.application.agent_runs import lookup, authority
    actor = Actor.model_validate(run['_actor'])
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            authority(ctx, store, actor, current, running=True)
            if current.get('_lease_token') != run.get('_lease_token'):
                raise ValidationError('Goal judging lease changed')
            if current['model_attempts'] >= current['limits']['max_model_attempts']:
                return 'blocked', 'model attempt limit exhausted', False, None, False
            reservation = reserve_usage(ctx, actor, current, purpose='agent_run.goal_judge', store=store)
            current['model_attempts'] += 1
        ctx.service.store = store
    result = None
    error_usage = None
    try:
        data = dict(inputs)
        if data.get('contract') is not None:
            data['contract'] = data['contract'].to_dict()
        data['observations'] = run.get('observations', [])
        result = complete(ctx, run, [
            ChatMessage(role='system', content='Evaluate the approved goal against supplied evidence. '
                'Do not accept claims alone as proof. Return JSON matching this schema: ' + json.dumps(Verdict.model_json_schema())),
            ChatMessage(role='user', content=json.dumps(data, ensure_ascii=False)),
        ], connection_id=run['connection_id'])
        parsed = Verdict.model_validate_json(_extract_json_payload(result.text))
        wait = {'seconds': parsed.wait_seconds} if parsed.verdict == 'wait' and parsed.wait_seconds and parsed.wait_seconds > 0 else None
        if parsed.verdict == 'wait' and wait is None:
            return 'continue', 'Invalid goal wait duration', True, None, False
        return parsed.verdict, parsed.reason, False, wait, False
    except (ValueError, TypeError):
        return 'continue', 'Goal judge returned invalid JSON', True, None, False
    except Exception as exc:
        error_usage = getattr(exc, 'usage', None)
        return 'continue', 'Goal judge transport failed', False, None, True
    finally:
        charge(ctx, actor, run, reservation, getattr(result, 'usage', None) or error_usage)
