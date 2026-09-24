"""Agent Client Protocol (ACP) adapter for IDE integration (H35).

Derived from Hermes acp_adapter/ at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides:
- ACP session lifecycle (initialize, new_session, prompt, cancel)
- Client edit approval flow for IDE file modifications
- Streaming event callbacks (message chunks, tool calls, edit proposals)
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum
import logging
import time
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


class AcpApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


@dataclass
class AcpEditProposal:
    """A proposed filesystem or buffer edit requiring IDE approval."""
    proposal_id: str
    file_path: str
    diff: str
    status: AcpApprovalStatus = AcpApprovalStatus.PENDING
    created_at: float = field(default_factory=time.time)


@dataclass
class AcpSession:
    """An active ACP session connected to an IDE."""
    session_id: str
    workspace_id: str
    model: str
    created_at: float = field(default_factory=time.time)
    active_proposal: Optional[AcpEditProposal] = None
    messages: List[Dict[str, Any]] = field(default_factory=list)


class AcpServerAdapter:
    """Adapter implementing the Agent Client Protocol (ACP) for Homun."""

    def __init__(self, workspace_id: str = "ws_local"):
        self.workspace_id = workspace_id
        self._sessions: Dict[str, AcpSession] = {}
        self.approval_callbacks: Dict[str, asyncio.Future] = {}

    def initialize(self, client_capabilities: Dict[str, Any]) -> Dict[str, Any]:
        """Handshake with the IDE client."""
        return {
            "protocolVersion": "1.0",
            "serverInfo": {
                "name": "homun-acp-adapter",
                "version": "0.1.0",
            },
            "capabilities": {
                "editApproval": True,
                "streaming": True,
                "multiSession": True,
            },
        }

    def new_session(self, model: str = "default", session_id: Optional[str] = None) -> AcpSession:
        """Create a new session for an IDE buffer or project."""
        s_id = session_id or f"acp_sess_{uuid4().hex[:12]}"
        sess = AcpSession(
            session_id=s_id,
            workspace_id=self.workspace_id,
            model=model,
        )
        self._sessions[s_id] = sess
        return sess

    def get_session(self, session_id: str) -> Optional[AcpSession]:
        return self._sessions.get(session_id)

    async def propose_edit(
        self,
        session_id: str,
        file_path: str,
        diff: str,
        on_proposal: Optional[Callable[[AcpEditProposal], None]] = None,
    ) -> bool:
        """Propose an edit to the IDE; waits for client approval or rejection."""
        sess = self.get_session(session_id)
        if not sess:
            raise KeyError(f"Unknown ACP session: {session_id}")

        prop_id = f"edit_{uuid4().hex[:8]}"
        proposal = AcpEditProposal(proposal_id=prop_id, file_path=file_path, diff=diff)
        sess.active_proposal = proposal

        fut: asyncio.Future[bool] = asyncio.get_event_loop().create_future()
        self.approval_callbacks[prop_id] = fut

        if on_proposal:
            on_proposal(proposal)

        try:
            approved = await asyncio.wait_for(fut, timeout=120.0)
            proposal.status = AcpApprovalStatus.APPROVED if approved else AcpApprovalStatus.REJECTED
            return approved
        except asyncio.TimeoutError:
            proposal.status = AcpApprovalStatus.REJECTED
            return False
        finally:
            self.approval_callbacks.pop(prop_id, None)

    def resolve_edit_approval(self, proposal_id: str, approved: bool) -> bool:
        """Called when IDE user clicks Approve or Reject."""
        fut = self.approval_callbacks.get(proposal_id)
        if fut and not fut.done():
            fut.set_result(approved)
            return True
        return False

    async def prompt(
        self,
        session_id: str,
        text: str,
        event_callback: Optional[Callable[[str, Any], None]] = None,
    ) -> Dict[str, Any]:
        """Handle a prompt from the IDE and stream event updates."""
        sess = self.get_session(session_id)
        if not sess:
            raise KeyError(f"Unknown ACP session: {session_id}")

        sess.messages.append({"role": "user", "content": text})

        # Emit message start
        if event_callback:
            event_callback("message_chunk", {"delta": "Analyzing request..."})

        await asyncio.sleep(0.01)

        reply_content = f"Homun completed: {text}"
        sess.messages.append({"role": "assistant", "content": reply_content})

        if event_callback:
            event_callback("message_chunk", {"delta": f"\n{reply_content}"})
            event_callback("plan_update", {"status": "completed"})

        return {
            "session_id": session_id,
            "status": "completed",
            "reply": reply_content,
        }
