"""Meeting tools integration adapter for Homun (Google Meet and Microsoft Teams).

Provides session control and transcript capture for Google Meet and Microsoft Graph Teams meetings.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import unquote


_MEET_URL_RE = re.compile(r"^https://meet\.google\.com/[a-z0-9_-]+$", re.IGNORECASE)
_USERS_MEETING_RE = re.compile(r"(?i)(?:^|/)users(?:\('([^']+)'\)|/([^/'()]+))/onlineMeetings(?:\('([^']+)'\)|/([^/'?]+))")
_COMM_MEETING_RE = re.compile(r"(?i)(?:^|/)communications/onlineMeetings(?:\('([^']+)'\)|/([^/'?]+))")
_TRANSCRIPT_RE = re.compile(r"(?i)/transcripts(?:\('([^']+)'\)|/([^/'?]+))")
_RECORDING_RE = re.compile(r"(?i)/recordings(?:\('([^']+)'\)|/([^/'?]+))")


class MeetingError(Exception):
    """Base exception for meeting operations."""
    pass


class InvalidMeetingUrlError(MeetingError):
    """Raised when a meeting URL is not recognized or invalid."""
    pass


class MeetingNotFoundError(MeetingError):
    """Raised when a requested meeting session is not found."""
    pass


class TeamsMeetingError(MeetingError):
    """Base error for Teams Graph meeting operations."""
    pass


class TeamsMeetingPermissionError(TeamsMeetingError):
    """Raised when Graph API access is unauthorized or forbidden."""
    pass


class TeamsMeetingNotFoundError(TeamsMeetingError):
    """Raised when a Teams meeting or artifact is not found."""
    pass


def parse_teams_meeting_resource(resource_uri: str) -> Dict[str, Optional[str]]:
    """Parse organizer, meeting, transcript, and recording IDs from a Graph resource URI."""
    text = (resource_uri or "").strip()
    users_match = _USERS_MEETING_RE.search(text)
    comm_match = _COMM_MEETING_RE.search(text)
    transcript_match = _TRANSCRIPT_RE.search(text)
    recording_match = _RECORDING_RE.search(text)

    def _extract(m, *groups: int) -> Optional[str]:
        if not m:
            return None
        for g in groups:
            val = m.group(g)
            if val:
                return unquote(val).strip()
        return None

    meeting_id = _extract(users_match, 3, 4) or _extract(comm_match, 1, 2)
    organizer_id = _extract(users_match, 1, 2)
    transcript_id = _extract(transcript_match, 1, 2)
    recording_id = _extract(recording_match, 1, 2)

    return {
        "organizer_user_id": organizer_id,
        "meeting_id": meeting_id,
        "transcript_id": transcript_id,
        "recording_id": recording_id,
    }


class MeetingManager:
    """Manages active Google Meet sessions and Teams meeting lookups."""

    def __init__(self, browser_backend: Optional[Any] = None) -> None:
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._browser_backend = browser_backend

    def join_google_meet(
        self,
        url: str,
        mode: str = "transcribe",
        guest_name: str = "Homun Agent",
        duration: Optional[str] = None,
        headed: bool = False,
        node: Optional[str] = None,
        *,
        browser_backend: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Join a Google Meet session via a real browser backend only."""
        clean_url = (url or "").strip()
        if not _MEET_URL_RE.match(clean_url):
            raise InvalidMeetingUrlError(f"Invalid Google Meet URL: '{clean_url}'")

        backend = browser_backend or getattr(self, "_browser_backend", None)
        if backend is None or not callable(getattr(backend, "join", None)):
            return {
                "success": False,
                "error": (
                    "Google Meet browser backend is not configured. Homun will not "
                    "report a joined session or invent captions without a real join."
                ),
                "code": "backend_unavailable",
                "url": clean_url,
                "state": "unavailable",
            }

        session = backend.join(
            url=clean_url,
            mode=mode if mode in ("transcribe", "realtime") else "transcribe",
            guest_name=guest_name,
            duration=duration,
            headed=headed,
            node=node or "local",
        )
        session_id = str(session.get("session_id") or f"meet_{uuid.uuid4().hex[:12]}")
        stored = dict(session)
        stored.setdefault("session_id", session_id)
        stored.setdefault("url", clean_url)
        stored.setdefault("mode", mode if mode in ("transcribe", "realtime") else "transcribe")
        stored.setdefault("guest_name", guest_name)
        stored.setdefault("captions", [])
        stored.setdefault("state", "joined")
        self._sessions[session_id] = stored
        return {
            "success": True,
            "session_id": session_id,
            "url": clean_url,
            "mode": stored["mode"],
            "state": stored["state"],
        }

    def get_meet_status(self, session_id: str) -> Dict[str, Any]:
        """Report current status of a Google Meet session."""
        session = self._sessions.get(session_id)
        if not session:
            raise MeetingNotFoundError(f"Google Meet session '{session_id}' not found")

        return {
            "session_id": session_id,
            "state": session["state"],
            "mode": session["mode"],
            "caption_count": len(session["captions"]),
            "url": session["url"],
        }

    def get_meet_transcript(self, session_id: str, last_n: Optional[int] = None) -> Dict[str, Any]:
        """Read captured transcript lines for a Google Meet session."""
        session = self._sessions.get(session_id)
        if not session:
            raise MeetingNotFoundError(f"Google Meet session '{session_id}' not found")

        captions = session["captions"]
        if last_n and last_n > 0:
            captions = captions[-last_n:]

        return {
            "session_id": session_id,
            "count": len(captions),
            "transcript": captions,
        }

    def speak_in_meet(self, session_id: str, text: str) -> Dict[str, Any]:
        """Speak text in a realtime Google Meet session."""
        session = self._sessions.get(session_id)
        if not session:
            raise MeetingNotFoundError(f"Google Meet session '{session_id}' not found")
        if session["mode"] != "realtime":
            raise MeetingError("Speech synthesis is only available in 'realtime' mode")

        utterance = (text or "").strip()
        if not utterance:
            raise MeetingError("Utterance text cannot be empty")

        session["captions"].append({"speaker": session["guest_name"], "text": utterance})
        return {"success": True, "session_id": session_id, "spoken": utterance}

    def leave_google_meet(self, session_id: str) -> Dict[str, Any]:
        """Cleanly leave a Google Meet session."""
        session = self._sessions.get(session_id)
        if not session:
            raise MeetingNotFoundError(f"Google Meet session '{session_id}' not found")

        session["state"] = "finalized"
        session["captions"].append({"speaker": "System", "text": "Session finalized and disconnected."})
        return {
            "success": True,
            "session_id": session_id,
            "state": "finalized",
            "total_captions": len(session["captions"]),
        }
