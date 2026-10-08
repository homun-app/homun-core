"""Delegation tools admit durable canonical children; no synchronous model shortcut."""
from homun.domain.errors import ValidationError


from homun.application.delegation_schema import _validate_schema


def execute(ctx, actor, run, tool, args):
    if run.get("delegation", {}).get("policy") != "isolated-subagent-v1":
        raise ValidationError("Delegation tools are not enabled for this run")
    if tool == "delegate_task":
        from homun.application.delegation_admission import admit
        return admit(ctx, actor, run, args)
    from homun.application.delegation_runtime import inspect_child, cancel_child
    if tool == "delegation_poll":
        return inspect_child(ctx, actor, run, args['delegation_id'])
    if tool == "delegation_cancel":
        return cancel_child(ctx, actor, run, args['delegation_id'])
    raise ValidationError(f"Unknown delegation tool: {tool}")
