"""Tests for H43 Optional Integrations: Home Assistant, Discord, Feishu, Yuanbao, Spotify, and Meetings."""

import pytest
import httpx
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.integration_homeassistant import (
    HomeAssistantAdapter,
    HomeAssistantSecurityError,
    HomeAssistantTransportError,
    BLOCKED_DOMAINS,
)
from homun.application.integration_discord import (
    DiscordAdapter,
    DiscordPermissionError,
    DiscordNotFoundError,
)
from homun.application.integration_feishu import (
    FeishuAdapter,
    FeishuNotConfiguredError,
)
from homun.application.integration_yuanbao import (
    YuanbaoAdapter,
    YuanbaoAmbiguousRecipientError,
    YuanbaoNotConnectedError,
    format_mention,
)
from homun.application.integration_spotify import (
    SpotifyAdapter,
    SpotifyAuthRequiredError,
    SpotifyError,
    normalize_spotify_id,
    normalize_spotify_uri,
)
from homun.application.integration_meetings import (
    InvalidMeetingUrlError,
    MeetingError,
    MeetingManager,
    parse_teams_meeting_resource,
)


def test_homeassistant_security_and_operations():
    # 1. Blocked domains check
    adapter = HomeAssistantAdapter(token="mock_token")
    for blocked in BLOCKED_DOMAINS:
        with pytest.raises(HomeAssistantSecurityError, match="blocked for security"):
            adapter.call_service(domain=blocked, service="run")

    # 2. Invalid service/domain syntax
    with pytest.raises(HomeAssistantSecurityError, match="Invalid domain"):
        adapter.call_service(domain="../api/shell", service="test")

    with pytest.raises(HomeAssistantSecurityError, match="Invalid service"):
        adapter.call_service(domain="light", service="turn-on-now!")

    # 3. Missing token transport error
    no_token_adapter = HomeAssistantAdapter(token="")
    with pytest.raises(HomeAssistantTransportError, match="token is not configured"):
        no_token_adapter.list_entities()

    # 4. Mock client for valid entity listing and state inspection
    mock_responses = {
        "/api/states": [
            {"entity_id": "light.living_room", "state": "on", "attributes": {"friendly_name": "Living Room Light", "area": "Living Room"}},
            {"entity_id": "switch.kitchen_fan", "state": "off", "attributes": {"friendly_name": "Kitchen Fan", "area": "Kitchen"}},
            {"entity_id": "light.bedroom", "state": "off", "attributes": {"friendly_name": "Bedroom Lamp", "area": "Bedroom"}},
        ],
        "/api/states/light.living_room": {
            "entity_id": "light.living_room",
            "state": "on",
            "attributes": {"friendly_name": "Living Room Light"},
            "last_changed": "2026-09-24T20:00:00Z",
        },
        "/api/services/light/turn_off": {"status": "ok"},
    }

    def mock_transport(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in mock_responses:
            return httpx.Response(200, json=mock_responses[path])
        return httpx.Response(404, text="Not Found")

    client = httpx.Client(transport=httpx.MockTransport(mock_transport))
    test_adapter = HomeAssistantAdapter(token="secret_token", client=client)

    # Filter by domain
    lights = test_adapter.list_entities(domain="light")
    assert lights["count"] == 2
    assert all(e["entity_id"].startswith("light.") for e in lights["entities"])

    # Filter by area
    kitchen = test_adapter.list_entities(area="kitchen")
    assert kitchen["count"] == 1
    assert kitchen["entities"][0]["entity_id"] == "switch.kitchen_fan"

    # Get state
    state = test_adapter.get_state("light.living_room")
    assert state["state"] == "on"

    # Call service (reversible action)
    res = test_adapter.call_service("light", "turn_off", entity_id="light.living_room")
    assert res["success"] is True
    assert res["previous_state"] == "on"


def test_discord_adapter_and_reversible_actions():
    # 1. Missing token raises permission error
    no_token = DiscordAdapter(bot_token="")
    with pytest.raises(DiscordPermissionError, match="token is missing"):
        no_token.list_guilds()

    # 2. Mock transport for Discord API
    def mock_discord_transport(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v10/users/@me/guilds":
            return httpx.Response(200, json=[{"id": "g1", "name": "Homun Server"}])
        if path == "/api/v10/guilds/g1":
            return httpx.Response(200, json={"id": "g1", "name": "Homun Server", "approximate_member_count": 10})
        if path == "/api/v10/guilds/g1/members/search":
            return httpx.Response(200, json=[{"user": {"id": "u1", "username": "alice"}}])
        if path.startswith("/api/v10/channels/c1/pins/m1"):
            if request.method in ("PUT", "DELETE"):
                return httpx.Response(204)
        if path.startswith("/api/v10/guilds/g1/members/u1/roles/r1"):
            if request.method in ("PUT", "DELETE"):
                return httpx.Response(204)
        if path == "/api/v10/channels/c1/threads":
            return httpx.Response(200, json={"id": "th1", "name": "General Thread"})
        return httpx.Response(404, text="Not Found")

    client = httpx.Client(transport=httpx.MockTransport(mock_discord_transport))
    discord = DiscordAdapter(bot_token="test_bot_token", client=client)

    guilds = discord.list_guilds()
    assert len(guilds) == 1
    assert guilds[0]["name"] == "Homun Server"

    info = discord.get_server_info("g1")
    assert info["approximate_member_count"] == 10

    members = discord.search_members("g1", "ali")
    assert len(members) == 1
    assert members[0]["user"]["username"] == "alice"

    # Reversible pair: pin and unpin
    pin_res = discord.pin_message("c1", "m1")
    assert pin_res["success"] is True
    unpin_res = discord.unpin_message("c1", "m1")
    assert unpin_res["success"] is True

    # Reversible pair: add role and remove role
    add_role_res = discord.add_role("g1", "u1", "r1")
    assert add_role_res["success"] is True
    rem_role_res = discord.remove_role("g1", "u1", "r1")
    assert rem_role_res["success"] is True

    thread_res = discord.create_thread("c1", "General Thread")
    assert thread_res["thread_id"] == "th1"


def test_feishu_adapter():
    # 1. Missing token
    unconfigured = FeishuAdapter(tenant_access_token="")
    with pytest.raises(FeishuNotConfiguredError):
        unconfigured.read_document("doc_xyz")

    # 2. Mock transport
    def mock_feishu_transport(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/open-apis/docx/v1/documents/doc_123/raw_content":
            return httpx.Response(200, json={"code": 0, "msg": "ok", "data": {"content": "# Project Brief\nApproved details."}})
        if path == "/open-apis/drive/v1/files/doc_123/comments":
            return httpx.Response(200, json={"code": 0, "msg": "ok", "data": {"items": [{"comment_id": "c1", "content": "LGTM"}]}})
        if path == "/open-apis/drive/v1/files/doc_123/new_comments":
            return httpx.Response(200, json={"code": 0, "msg": "ok", "data": {"comment_id": "c2"}})
        return httpx.Response(404, json={"code": 404, "msg": "not found"})

    client = httpx.Client(transport=httpx.MockTransport(mock_feishu_transport))
    feishu = FeishuAdapter(tenant_access_token="valid_tenant_token", client=client)

    content = feishu.read_document("doc_123")
    assert "# Project Brief" in content

    comments = feishu.list_comments("doc_123")
    assert len(comments.get("items", [])) == 1

    new_cmt = feishu.add_comment("doc_123", "Needs review")
    assert new_cmt.get("comment_id") == "c2"


def test_yuanbao_adapter_and_disambiguation():
    # 1. Disconnected
    disconnected = YuanbaoAdapter(connected=False)
    with pytest.raises(YuanbaoNotConnectedError):
        disconnected.get_group_info("grp_1")

    # 2. Mention formatting
    assert format_mention("Alice") == " @Alice "
    assert format_mention(" Bob ") == " @Bob "

    # 3. Connected adapter with members provider
    members_data = [
        {"user_id": "u1", "nickname": "Zhang Wei", "role": "member"},
        {"user_id": "u2", "nickname": "Zhang San", "role": "member"},
        {"user_id": "u3", "nickname": "Li Si", "role": "member"},
    ]
    yb = YuanbaoAdapter(connected=True, mock_members_provider=lambda _grp: members_data)

    # Search sticker
    stickers = yb.search_sticker("点赞")
    assert len(stickers) == 1
    assert stickers[0]["sticker_id"] == "stk_thumbs_up"

    # Send sticker
    stk_res = yb.send_sticker("grp_1", "stk_thumbs_up")
    assert stk_res["delivered"] is True

    # Ambiguous recipient
    with pytest.raises(YuanbaoAmbiguousRecipientError) as exc_info:
        yb.send_dm("grp_1", "Hello", name="Zhang")
    assert len(exc_info.value.candidates) == 2

    # Resolved recipient
    dm_res = yb.send_dm("grp_1", "Hello Li", name="Li Si")
    assert dm_res["recipient_user_id"] == "u3"
    assert dm_res["mention"] == " @Li Si "
    assert dm_res["delivered"] is True


def test_spotify_adapter_and_normalization():
    # 1. Normalization
    assert normalize_spotify_uri("spotify:track:4cOdK2wGLETKBW3PvgPWqT") == "spotify:track:4cOdK2wGLETKBW3PvgPWqT"
    assert normalize_spotify_uri("4cOdK2wGLETKBW3PvgPWqT", expected_type="track") == "spotify:track:4cOdK2wGLETKBW3PvgPWqT"
    assert normalize_spotify_id("spotify:track:4cOdK2wGLETKBW3PvgPWqT") == "4cOdK2wGLETKBW3PvgPWqT"
    with pytest.raises(SpotifyError):
        normalize_spotify_uri("invalid_short_id")

    # 2. Missing token
    unauth = SpotifyAdapter(access_token="")
    with pytest.raises(SpotifyAuthRequiredError):
        unauth.get_playback_state()

    # 3. Mock client
    def mock_spotify_transport(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/me/player":
            return httpx.Response(200, json={"is_playing": True, "item": {"name": "Song 1"}})
        if path in ("/v1/me/player/play", "/v1/me/player/pause", "/v1/me/player/next", "/v1/me/player/previous"):
            return httpx.Response(204)
        if path == "/v1/me/tracks":
            return httpx.Response(204)
        if path == "/v1/tracks/4cOdK2wGLETKBW3PvgPWqT":
            return httpx.Response(200, json={"id": "4cOdK2wGLETKBW3PvgPWqT", "name": "Song 1"})
        return httpx.Response(404, text="Not Found")

    client = httpx.Client(transport=httpx.MockTransport(mock_spotify_transport))
    spotify = SpotifyAdapter(access_token="valid_spotify_token", client=client)

    playback = spotify.get_playback_state()
    assert playback["is_playing"] is True

    assert spotify.pause()["success"] is True
    assert spotify.play()["success"] is True

    # Reversible track library operations
    save_res = spotify.save_track("4cOdK2wGLETKBW3PvgPWqT")
    assert save_res["action"] == "save_track"
    rem_res = spotify.remove_track("4cOdK2wGLETKBW3PvgPWqT")
    assert rem_res["action"] == "remove_track"


def test_meetings_manager_and_teams_parser():
    # 1. Teams Graph Resource URI parsing
    graph_uri = "https://graph.microsoft.com/v1.0/users('organizer_123')/onlineMeetings('meeting_456')/transcripts('transcript_789')"
    parsed = parse_teams_meeting_resource(graph_uri)
    assert parsed["organizer_user_id"] == "organizer_123"
    assert parsed["meeting_id"] == "meeting_456"
    assert parsed["transcript_id"] == "transcript_789"

    # Communications format
    comm_uri = "/communications/onlineMeetings/meeting_abc/recordings/rec_xyz"
    parsed_comm = parse_teams_meeting_resource(comm_uri)
    assert parsed_comm["meeting_id"] == "meeting_abc"
    assert parsed_comm["recording_id"] == "rec_xyz"

    # 2. Google Meet manager
    mgr = MeetingManager()

    # Invalid URL
    with pytest.raises(InvalidMeetingUrlError):
        mgr.join_google_meet("https://example.com/not-meet")

    # Valid join
    join_res = mgr.join_google_meet("https://meet.google.com/abc-defg-hij", mode="realtime", guest_name="Homun Bot")
    assert join_res["success"] is True
    session_id = join_res["session_id"]

    # Status
    status = mgr.get_meet_status(session_id)
    assert status["state"] == "joined"
    assert status["mode"] == "realtime"

    # Speak (realtime mode)
    speak_res = mgr.speak_in_meet(session_id, "Hello everyone from Homun Agent")
    assert speak_res["spoken"] == "Hello everyone from Homun Agent"

    # Transcript with last_n filter
    transcript = mgr.get_meet_transcript(session_id, last_n=1)
    assert transcript["count"] == 1
    assert transcript["transcript"][0]["speaker"] == "Homun Bot"

    # Leave cleanly
    leave_res = mgr.leave_google_meet(session_id)
    assert leave_res["state"] == "finalized"


def test_integrations_fastapi_endpoints():
    app = create_app()
    client = TestClient(app)

    # Test Google Meet endpoints
    join_resp = client.post("/v1/integrations/meetings/meet/join", json={"url": "https://meet.google.com/xyz-uvwx-rst"})
    assert join_resp.status_code == 200
    session_id = join_resp.json()["session_id"]

    status_resp = client.get(f"/v1/integrations/meetings/meet/status?session_id={session_id}")
    assert status_resp.status_code == 200
    assert status_resp.json()["state"] == "joined"

    leave_resp = client.post("/v1/integrations/meetings/meet/leave", json={"session_id": session_id})
    assert leave_resp.status_code == 200
    assert leave_resp.json()["state"] == "finalized"

    # Test Teams parse endpoint
    teams_resp = client.post(
        "/v1/integrations/meetings/teams/parse",
        json={"resource_uri": "users('usr_1')/onlineMeetings('mtg_2')"},
    )
    assert teams_resp.status_code == 200
    assert teams_resp.json()["meeting_id"] == "mtg_2"

    # Test Home Assistant security rejection via HTTP
    ha_resp = client.post(
        "/v1/integrations/homeassistant/call",
        json={"domain": "shell_command", "service": "wipe_system"},
    )
    assert ha_resp.status_code == 403
