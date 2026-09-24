"""Tests for H34: Multi-surface gateway, connections, steering, and approvals."""
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.surface_contracts import ConnectionTransportKind, SurfaceKind
from homun.application.surface_gateway_manager import SurfaceGatewayManager


def test_surface_gateway_manager():
    mgr = SurfaceGatewayManager()

    # Register connections
    c1 = mgr.register_connection(
        surface_kind=SurfaceKind.CLI,
        transport=ConnectionTransportKind.LOCAL,
        profile="work",
    )
    assert c1.surface_kind == SurfaceKind.CLI
    assert c1.transport == ConnectionTransportKind.LOCAL
    assert c1.profile == "work"

    c2 = mgr.register_connection(
        surface_kind=SurfaceKind.TUI,
        transport=ConnectionTransportKind.SSH,
        profile="work",
    )
    assert len(mgr.list_connections(profile="work")) == 2
    assert len(mgr.list_connections(profile="other")) == 0

    # Sync session state
    snap = mgr.sync_session_state(
        session_id="sess_123",
        profile="work",
        surface_kind=SurfaceKind.CLI,
        status="working",
        title="Develop feature",
        cwd="/workspace/project",
        active_tools=["terminal", "read_file"],
    )
    assert snap.status == "working"
    assert snap.title == "Develop feature"

    # Queue steering guidance from TUI or other surface
    mgr.queue_steering_guidance("sess_123", "Stop running tests, check linter instead")
    snap_after = mgr.get_session_snapshot("sess_123")
    assert len(snap_after.pending_steering) == 1
    assert "linter" in snap_after.pending_steering[0].guidance

    # Drain steering
    drained = mgr.drain_steering_guidance("sess_123")
    assert len(drained) == 1
    assert len(mgr.drain_steering_guidance("sess_123")) == 0

    # Request and resolve approval
    appr = mgr.request_approval(
        session_id="sess_123",
        tool_name="terminal",
        command="rm -rf ./tmp",
        description="Clean temp directory",
    )
    assert appr.resolved is False

    snap_with_appr = mgr.get_session_snapshot("sess_123")
    assert len(snap_with_appr.pending_approvals) == 1

    resolved = mgr.resolve_approval(appr.request_id, "once")
    assert resolved.resolved is True
    assert resolved.decision == "once"

    snap_clean = mgr.get_session_snapshot("sess_123")
    assert len(snap_clean.pending_approvals) == 0

    # Register artifact
    art = mgr.register_artifact(
        session_id="sess_123",
        artifact_type="pdf",
        path_or_url="/tmp/report.pdf",
    )
    assert art["type"] == "pdf"
    assert len(mgr.get_session_snapshot("sess_123").artifacts) == 1

    # Disconnect
    assert mgr.disconnect(c1.connection_id) is True
    assert len(mgr.list_connections()) == 1


def test_surface_gateway_api_endpoints():
    app = create_app()
    client = TestClient(app)

    # Register connection
    res_reg = client.post(
        "/v1/surfaces/connections",
        json={"surface_kind": "desktop", "transport": "local", "profile": "default"},
    )
    assert res_reg.status_code == 200
    conn_id = res_reg.json()["connection_id"]

    # List connections
    res_list = client.get("/v1/surfaces/connections")
    assert res_list.status_code == 200
    assert any(c["connection_id"] == conn_id for c in res_list.json()["connections"])

    # Sync session
    res_sync = client.post(
        "/v1/surfaces/sessions/sync",
        json={
            "session_id": "sess_api",
            "profile": "default",
            "surface_kind": "desktop",
            "status": "working",
            "title": "API sync test",
        },
    )
    assert res_sync.status_code == 200
    assert res_sync.json()["title"] == "API sync test"

    # Queue steering
    res_steer = client.post(
        "/v1/surfaces/steering",
        json={"session_id": "sess_api", "guidance": "Please wrap up task"},
    )
    assert res_steer.status_code == 200

    # Snapshot
    res_snap = client.get("/v1/surfaces/sessions/sess_api/snapshot")
    assert res_snap.status_code == 200
    assert len(res_snap.json()["pending_steering"]) == 1

    # Drain steering
    res_drain = client.post("/v1/surfaces/sessions/sess_api/steering/drain")
    assert res_drain.status_code == 200
    assert len(res_drain.json()["guidance_list"]) == 1

    # Create & resolve approval
    res_appr = client.post(
        "/v1/surfaces/approvals",
        json={
            "session_id": "sess_api",
            "tool_name": "terminal",
            "command": "git push",
            "description": "Push code to remote",
        },
    )
    assert res_appr.status_code == 200
    req_id = res_appr.json()["request_id"]

    res_res = client.post(
        f"/v1/surfaces/approvals/{req_id}/resolve",
        json={"decision": "deny"},
    )
    assert res_res.status_code == 200
    assert res_res.json()["decision"] == "deny"

    # Disconnect
    res_disc = client.delete(f"/v1/surfaces/connections/{conn_id}")
    assert res_disc.status_code == 200
