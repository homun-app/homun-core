"""Validated durable decisions for native runs supporting textual continuation."""
from pydantic import Field
from homun.models.agent_turn import AgentDecision
from homun.models.truncation import MAX_TEXT_CHARACTERS


class ContinuationDecision(AgentDecision):
    message: str = Field(min_length=1, max_length=MAX_TEXT_CHARACTERS)
