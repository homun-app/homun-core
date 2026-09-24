"""FastAPI router for optional integrations (Home Assistant, Discord, Feishu, Yuanbao, Spotify, Meetings)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from homun.application.integration_homeassistant import (
    HomeAssistantAdapter,
    HomeAssistantError,
    HomeAssistantNotFoundError,
    HomeAssistantSecurityError,
    HomeAssistantTransportError,
)
from homun.application.integration_discord import (
    DiscordAdapter,
    DiscordAPIError,
    DiscordNotFoundError,
    DiscordPermissionError,
)
from homun.application.integration_feishu import (
    FeishuAdapter,
    FeishuAPIError,
    FeishuError,
    FeishuNotConfiguredError,
)
from homun.application.integration_yuanbao import (
    YuanbaoAdapter,
    YuanbaoAmbiguousRecipientError,
    YuanbaoError,
    YuanbaoNotConnectedError,
)
from homun.application.integration_spotify import (
    SpotifyAdapter,
    SpotifyAPIError,
    SpotifyAuthRequiredError,
    SpotifyError,
)
from homun.application.integration_meetings import (
    InvalidMeetingUrlError,
    MeetingError,
    MeetingManager,
    MeetingNotFoundError,
    parse_teams_meeting_resource,
)

router = APIRouter(prefix="/v1/integrations", tags=["integrations"])

# Module-level default instances
_ha_adapter = HomeAssistantAdapter()
_discord_adapter = DiscordAdapter()
_feishu_adapter = FeishuAdapter()
_yuanbao_adapter = YuanbaoAdapter()
_spotify_adapter = SpotifyAdapter()
_meeting_manager = MeetingManager()


# ── Home Assistant Schemas & Endpoints ──────────────────────────────────────────

class HACallRequest(BaseModel):
    domain: str = Field(..., description="Service domain (e.g. 'light', 'switch')")
    service: str = Field(..., description="Service name (e.g. 'turn_on', 'turn_off')")
    entity_id: Optional[str] = Field(None, description="Target entity_id")
    service_data: Optional[Dict[str, Any]] = Field(None, description="Optional service parameters")


@router.get("/homeassistant/entities")
def ha_list_entities(
    domain: Optional[str] = Query(None, description="Filter by domain"),
    area: Optional[str] = Query(None, description="Filter by area"),
) -> Dict[str, Any]:
    try:
        return _ha_adapter.list_entities(domain=domain, area=area)
    except HomeAssistantSecurityError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except HomeAssistantTransportError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/homeassistant/states/{entity_id}")
def ha_get_state(entity_id: str) -> Dict[str, Any]:
    try:
        return _ha_adapter.get_state(entity_id)
    except HomeAssistantSecurityError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except HomeAssistantNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HomeAssistantTransportError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/homeassistant/call")
def ha_call_service(req: HACallRequest) -> Dict[str, Any]:
    try:
        return _ha_adapter.call_service(
            domain=req.domain,
            service=req.service,
            entity_id=req.entity_id,
            service_data=req.service_data,
        )
    except HomeAssistantSecurityError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except HomeAssistantNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HomeAssistantTransportError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Discord Schemas & Endpoints ────────────────────────────────────────────────

class DiscordActionRequest(BaseModel):
    action: str = Field(..., description="Action name (e.g. list_guilds, pin_message, create_thread)")
    guild_id: Optional[str] = None
    channel_id: Optional[str] = None
    message_id: Optional[str] = None
    user_id: Optional[str] = None
    role_id: Optional[str] = None
    name: Optional[str] = None
    query: Optional[str] = None
    limit: Optional[int] = 20
    before: Optional[str] = None
    after: Optional[str] = None


@router.post("/discord/action")
def discord_action(req: DiscordActionRequest) -> Any:
    try:
        act = req.action.lower()
        if act == "list_guilds":
            return _discord_adapter.list_guilds()
        if act == "server_info":
            if not req.guild_id:
                raise HTTPException(status_code=400, detail="guild_id is required")
            return _discord_adapter.get_server_info(req.guild_id)
        if act == "list_channels":
            if not req.guild_id:
                raise HTTPException(status_code=400, detail="guild_id is required")
            return _discord_adapter.list_channels(req.guild_id)
        if act == "channel_info":
            if not req.channel_id:
                raise HTTPException(status_code=400, detail="channel_id is required")
            return _discord_adapter.get_channel_info(req.channel_id)
        if act == "list_roles":
            if not req.guild_id:
                raise HTTPException(status_code=400, detail="guild_id is required")
            return _discord_adapter.list_roles(req.guild_id)
        if act == "member_info":
            if not req.guild_id or not req.user_id:
                raise HTTPException(status_code=400, detail="guild_id and user_id are required")
            return _discord_adapter.get_member_info(req.guild_id, req.user_id)
        if act == "search_members":
            if not req.guild_id:
                raise HTTPException(status_code=400, detail="guild_id is required")
            return _discord_adapter.search_members(req.guild_id, req.query or "", limit=req.limit or 20)
        if act == "fetch_messages":
            if not req.channel_id:
                raise HTTPException(status_code=400, detail="channel_id is required")
            return _discord_adapter.fetch_messages(
                req.channel_id, limit=req.limit or 50, before=req.before, after=req.after
            )
        if act == "list_pins":
            if not req.channel_id:
                raise HTTPException(status_code=400, detail="channel_id is required")
            return _discord_adapter.list_pins(req.channel_id)
        if act == "pin_message":
            if not req.channel_id or not req.message_id:
                raise HTTPException(status_code=400, detail="channel_id and message_id are required")
            return _discord_adapter.pin_message(req.channel_id, req.message_id)
        if act == "unpin_message":
            if not req.channel_id or not req.message_id:
                raise HTTPException(status_code=400, detail="channel_id and message_id are required")
            return _discord_adapter.unpin_message(req.channel_id, req.message_id)
        if act == "delete_message":
            if not req.channel_id or not req.message_id:
                raise HTTPException(status_code=400, detail="channel_id and message_id are required")
            return _discord_adapter.delete_message(req.channel_id, req.message_id)
        if act == "create_thread":
            if not req.channel_id or not req.name:
                raise HTTPException(status_code=400, detail="channel_id and name are required")
            return _discord_adapter.create_thread(req.channel_id, req.name, message_id=req.message_id)
        if act == "add_role":
            if not req.guild_id or not req.user_id or not req.role_id:
                raise HTTPException(status_code=400, detail="guild_id, user_id and role_id are required")
            return _discord_adapter.add_role(req.guild_id, req.user_id, req.role_id)
        if act == "remove_role":
            if not req.guild_id or not req.user_id or not req.role_id:
                raise HTTPException(status_code=400, detail="guild_id, user_id and role_id are required")
            return _discord_adapter.remove_role(req.guild_id, req.user_id, req.role_id)

        raise HTTPException(status_code=400, detail=f"Unknown discord action: '{req.action}'")
    except DiscordPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except DiscordNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except DiscordAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Feishu / Lark Schemas & Endpoints ──────────────────────────────────────────

class FeishuCommentRequest(BaseModel):
    file_token: str
    content: str
    file_type: Optional[str] = "docx"
    comment_id: Optional[str] = None


@router.get("/feishu/document")
def feishu_get_document(doc_token: str = Query(..., description="Document token")) -> Dict[str, Any]:
    try:
        content = _feishu_adapter.read_document(doc_token)
        return {"success": True, "doc_token": doc_token, "content": content}
    except FeishuNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FeishuAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except FeishuError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/feishu/comments")
def feishu_list_comments(
    file_token: str = Query(...),
    file_type: str = Query("docx"),
    is_whole: bool = Query(False),
    page_size: int = Query(100),
    page_token: str = Query(""),
) -> Dict[str, Any]:
    try:
        return _feishu_adapter.list_comments(
            file_token=file_token,
            file_type=file_type,
            is_whole=is_whole,
            page_size=page_size,
            page_token=page_token,
        )
    except FeishuNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FeishuAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except FeishuError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/feishu/comments")
def feishu_create_or_reply_comment(req: FeishuCommentRequest) -> Dict[str, Any]:
    try:
        if req.comment_id:
            return _feishu_adapter.reply_comment(req.file_token, req.comment_id, req.content)
        return _feishu_adapter.add_comment(req.file_token, req.content, file_type=req.file_type or "docx")
    except FeishuNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FeishuAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except FeishuError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Yuanbao Schemas & Endpoints ────────────────────────────────────────────────

class YuanbaoActionRequest(BaseModel):
    action: str
    group_code: str
    query: Optional[str] = None
    sticker_id: Optional[str] = None
    user_id: Optional[str] = None
    name: Optional[str] = None
    content: Optional[str] = None


@router.post("/yuanbao/action")
def yuanbao_action(req: YuanbaoActionRequest) -> Any:
    try:
        act = req.action.lower()
        if act == "group_info":
            return _yuanbao_adapter.get_group_info(req.group_code)
        if act == "query_members":
            return _yuanbao_adapter.query_group_members(req.group_code, query=req.query or "")
        if act == "search_sticker":
            return _yuanbao_adapter.search_sticker(query=req.query or "")
        if act == "send_sticker":
            if not req.sticker_id:
                raise HTTPException(status_code=400, detail="sticker_id is required")
            return _yuanbao_adapter.send_sticker(req.group_code, req.sticker_id)
        if act == "send_dm":
            if not req.content:
                raise HTTPException(status_code=400, detail="content is required")
            return _yuanbao_adapter.send_dm(
                req.group_code,
                content=req.content,
                user_id=req.user_id,
                name=req.name,
            )
        raise HTTPException(status_code=400, detail=f"Unknown yuanbao action: '{req.action}'")
    except YuanbaoNotConnectedError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except YuanbaoAmbiguousRecipientError as e:
        raise HTTPException(status_code=409, detail={"error": str(e), "candidates": e.candidates})
    except YuanbaoError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Spotify Schemas & Endpoints ────────────────────────────────────────────────

class SpotifyActionRequest(BaseModel):
    action: str
    query: Optional[str] = None
    types: Optional[List[str]] = None
    limit: Optional[int] = 20
    offset: Optional[int] = 0
    track_id: Optional[str] = None
    device_id: Optional[str] = None
    position_ms: Optional[int] = None
    volume_percent: Optional[int] = None
    uris: Optional[List[str]] = None
    context_uri: Optional[str] = None


@router.post("/spotify/action")
def spotify_action(req: SpotifyActionRequest) -> Any:
    try:
        act = req.action.lower()
        if act == "playback_state":
            return _spotify_adapter.get_playback_state()
        if act == "play":
            return _spotify_adapter.play(context_uri=req.context_uri, uris=req.uris, device_id=req.device_id)
        if act == "pause":
            return _spotify_adapter.pause(device_id=req.device_id)
        if act == "next":
            return _spotify_adapter.next_track(device_id=req.device_id)
        if act == "previous":
            return _spotify_adapter.previous_track(device_id=req.device_id)
        if act == "seek":
            if req.position_ms is None:
                raise HTTPException(status_code=400, detail="position_ms is required")
            return _spotify_adapter.seek(req.position_ms, device_id=req.device_id)
        if act == "volume":
            if req.volume_percent is None:
                raise HTTPException(status_code=400, detail="volume_percent is required")
            return _spotify_adapter.set_volume(req.volume_percent, device_id=req.device_id)
        if act == "search":
            if not req.query:
                raise HTTPException(status_code=400, detail="query is required")
            return _spotify_adapter.search(req.query, types=req.types, limit=req.limit or 20, offset=req.offset or 0)
        if act == "track":
            if not req.track_id:
                raise HTTPException(status_code=400, detail="track_id is required")
            return _spotify_adapter.get_track(req.track_id)
        if act == "save_track":
            if not req.track_id:
                raise HTTPException(status_code=400, detail="track_id is required")
            return _spotify_adapter.save_track(req.track_id)
        if act == "remove_track":
            if not req.track_id:
                raise HTTPException(status_code=400, detail="track_id is required")
            return _spotify_adapter.remove_track(req.track_id)

        raise HTTPException(status_code=400, detail=f"Unknown spotify action: '{req.action}'")
    except SpotifyAuthRequiredError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except SpotifyAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except SpotifyError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Meetings Schemas & Endpoints ───────────────────────────────────────────────

class MeetJoinRequest(BaseModel):
    url: str
    mode: Optional[str] = "transcribe"
    guest_name: Optional[str] = "Homun Agent"
    duration: Optional[str] = None
    headed: Optional[bool] = False
    node: Optional[str] = None


class MeetSpeakRequest(BaseModel):
    session_id: str
    text: str


class MeetLeaveRequest(BaseModel):
    session_id: str


class TeamsParseRequest(BaseModel):
    resource_uri: str


@router.post("/meetings/meet/join")
def meet_join(req: MeetJoinRequest) -> Dict[str, Any]:
    try:
        return _meeting_manager.join_google_meet(
            url=req.url,
            mode=req.mode or "transcribe",
            guest_name=req.guest_name or "Homun Agent",
            duration=req.duration,
            headed=bool(req.headed),
            node=req.node,
        )
    except InvalidMeetingUrlError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/meetings/meet/status")
def meet_status(session_id: str = Query(...)) -> Dict[str, Any]:
    try:
        return _meeting_manager.get_meet_status(session_id)
    except MeetingNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/meetings/meet/transcript")
def meet_transcript(
    session_id: str = Query(...),
    last_n: Optional[int] = Query(None),
) -> Dict[str, Any]:
    try:
        return _meeting_manager.get_meet_transcript(session_id, last_n=last_n)
    except MeetingNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/meetings/meet/speak")
def meet_speak(req: MeetSpeakRequest) -> Dict[str, Any]:
    try:
        return _meeting_manager.speak_in_meet(req.session_id, req.text)
    except MeetingNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except MeetingError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/meetings/meet/leave")
def meet_leave(req: MeetLeaveRequest) -> Dict[str, Any]:
    try:
        return _meeting_manager.leave_google_meet(req.session_id)
    except MeetingNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/meetings/teams/parse")
def teams_parse(req: TeamsParseRequest) -> Dict[str, Optional[str]]:
    return parse_teams_meeting_resource(req.resource_uri)
