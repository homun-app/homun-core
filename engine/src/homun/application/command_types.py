"""Transport-neutral command envelopes shared by HTTP and SSE."""
from typing import Any
from pydantic import BaseModel, Field

class CommandRequest(BaseModel):
    command_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class CommandResponse(BaseModel):
    command_id: str
    type: str
    status: str = "ok"
    result: dict[str, Any]


