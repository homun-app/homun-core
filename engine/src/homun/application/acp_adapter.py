"""Agent Client Protocol (ACP) adapter for IDE integration (H35).

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
from homun.domain.errors import BackendUnavailableError

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

    def __init__(self, workspace_id: str = "ws_local", *, runner=None, ctx=None, actor=None):
        self.workspace_id = workspace_id
        self._runner = runner
        self._ctx = ctx
        self._actor = actor
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
                "streaming": False,
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
        self, session_id: str, text: str,
        event_callback: Optional[Callable[[str, Any], None]] = None, *,
        command_id: Optional[str] = None, allow_tools: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Stage a canonical supervised run; never synthesize execution success."""
        sess = self.get_session(session_id)
        if not sess:
            raise KeyError(f"Unknown ACP session: {session_id}")
        if self._ctx is None:
            raise BackendUnavailableError("ACP requires an EngineContext")
        runner = self._runner
        if runner is None:
            from homun.application.hosted_mcp_runner import HostedMcpEngineRunner
            runner = HostedMcpEngineRunner()
        result = await asyncio.to_thread(runner.run_task, text, ctx=self._ctx,
                                         actor=self._actor, command_id=command_id,
                                         allow_tools=allow_tools)
        sess.messages.append({"role": "user", "content": text})
        if event_callback:
            event_callback("plan_update", result)
        return {"session_id": session_id, "source": "engine", **result}
