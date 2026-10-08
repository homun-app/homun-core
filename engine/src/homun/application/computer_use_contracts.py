"""Tool contract for computer use (vocabulary adapted from the Hermes skill)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry

TOOL_DESCRIPTION = (
    "Drive the user's macOS desktop in the background (no cursor/focus steal). "
    "Capture first: computer_use(action=\"capture\", app=\"...\") returns a "
    "screenshot plus indexed elements; then act on element=N. Sensitive "
    "surfaces (payments, banking) always wait for a human; hard-blocked input "
    "is refused outright."
)


class ComputerUseArguments(BaseModel):
    action: str = Field(description="capture first, then act on element=N")
    app: Optional[str] = None
    element: Optional[str] = None
    text: Optional[str] = None
    keys: Optional[str] = None
    direction: Optional[str] = None


def entries(handler, version=1) -> List[ToolEntry]:
    definition = ToolDefinition(
        name="computer_use",
        description=TOOL_DESCRIPTION,
        input_schema=ComputerUseArguments.model_json_schema(),
    )

    def run_action(ctx, actor, run, args):
        return handler(ctx, actor, run, "computer_use", args)

    return [ToolEntry(definition, "computer_use", str(version),
                      ComputerUseArguments, run_action, replay="read_only")]


def execute(ctx, actor, run, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Handler: classify through the three tiers, gate or execute."""
    from homun.application import computer_use_jobs
    from homun.domain.errors import ValidationError

    if name != "computer_use":
        raise ValidationError(f"Unknown tool: {name}")
    run_id = str(run.get("id") or "")
    work_id = str(run.get("work_id") or "")
    if not run_id or not work_id:
        raise ValidationError("computer_use needs a run bound to a work")
    gate = computer_use_jobs.propose(ctx, actor, work_id, run_id, dict(args))
    if gate["status"] == "pending_approval":
        return {
            "status": "pending_approval",
            "proposal_id": gate["id"],
            "digest": gate["digest"],
            "verdict": gate["verdict"],
            "message": ("Azione in attesa di approvazione umana "
                        "(superficie sensibile o app fuori allowlist)."),
        }
    return {"status": gate["status"], "verdict": gate["verdict"],
            "result": gate.get("result")}
