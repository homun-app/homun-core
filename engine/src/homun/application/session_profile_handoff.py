"""Cross-profile session handoff with two-sided authorization (C3c5).

Enforces separate source export and target acceptance authority, preserves
global active profile without switching, resolves target-local runtime connections,
and requires fresh human approval for target execution.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib
import json
from pathlib import Path
import time
from typing import Any, Callable, Dict, Optional

from homun.application import session_history
from homun.application.agent_run_request import RunRequest
from homun.application.price_comparisons import cached, save
from homun.domain.errors import (
    ConflictError,
    DomainError,
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
)
from homun.policy.work import require_work_access


def _command_id(args: Dict[str, Any]) -> str:
    value = args.get("command_id")
    if not isinstance(value, str) or not 1 <= len(value) <= 140:
        raise ValidationError("A command_id of 1 to 140 characters is required")
    return value


def _sanitize_for_cache(args: Dict[str, Any]) -> Dict[str, Any]:
    """Extract only JSON-serializable values for caching and fingerprints."""
    clean = {}
    for k, v in args.items():
        if callable(v):
            continue
        if hasattr(v, "id"):
            clean[f"{k}_id"] = v.id
        elif isinstance(v, (str, int, float, bool, list, dict)) or v is None:
            clean[k] = v
    return clean


def _compute_handoff_digest(payload: Dict[str, Any]) -> str:
    """Deterministic hash of invariant handoff packet properties."""
    canonical_data = {
        "source_profile": payload.get("source_profile"),
        "source_work_id": payload.get("source_work_id"),
        "source_session_id": payload.get("source_session_id"),
        "source_revision": payload.get("source_revision"),
        "target_profile": payload.get("target_profile"),
        "instruction": str(payload.get("instruction") or "").strip(),
        "messages": payload.get("messages", []),
        "workspace_mode": payload.get("workspace_mode", "history_only"),
        "manifest_digest": (
            payload.get("workspace_transfer", {}).get("digest")
            if isinstance(payload.get("workspace_transfer"), dict)
            else payload.get("manifest_digest")
        ),
        "runtime_preferences": payload.get("runtime_preferences", {}),
    }
    raw = json.dumps(canonical_data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def default_profile_context_resolver(ctx: Any, target_profile_name: str) -> Any:
    """Default resolver mapping target profile name to an isolated EngineContext."""
    from homun.application.profile_operations import ProfileNotFoundError, ProfileOperationsManager

    profiles_dir = ctx.data_dir / "profiles"
    if profiles_dir.exists():
        mgr = ProfileOperationsManager(profiles_dir)
        try:
            mgr.get_profile(target_profile_name)
        except Exception as exc:
            raise ProfileNotFoundError(f"Target profile '{target_profile_name}' does not exist") from exc

    target_root = profiles_dir / target_profile_name
    target_data_dir = target_root / "data"
    target_db_path = target_root / "homun.db"
    target_root.mkdir(parents=True, exist_ok=True)
    target_data_dir.mkdir(parents=True, exist_ok=True)

    create_ctx_fn = importlib.import_module("homun.context").create_context
    target_ctx = create_ctx_fn(
        workspace_id=f"ws_{target_profile_name}",
        db_path=target_db_path,
        data_dir=target_data_dir,
        for_tests=True,
    )
    target_ctx.profile_name = target_profile_name
    return target_ctx


def prepare_handoff(ctx: Any, actor: Any, work_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Export and prepare an immutable handoff packet from the source context."""
    command_id = _command_id(args)
    target_profile = str(args.get("target_profile") or "").strip().lower()
    if not target_profile or not target_profile.isalnum():
        raise ValidationError("target_profile must be a non-empty alphanumeric profile name")

    instruction = args.get("instruction")
    if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 16000:
        raise ValidationError("A new instruction of 1 to 16000 characters is required")

    session_id = str(args.get("session_id") or "").strip()
    if not session_id:
        raise ValidationError("session_id is required for handoff")

    profiles_dir = ctx.data_dir / "profiles"
    if profiles_dir.exists():
        from homun.application.profile_operations import ProfileOperationsManager
        ProfileOperationsManager(profiles_dir).get_profile(target_profile)

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id, "read")
            source = session_history.lookup(store, actor, work_id, session_id)
            clean_cache = _sanitize_for_cache({**args, "work_id": work_id})
            record, fingerprint = cached(store, actor, command_id, "session.handoff", clean_cache)
            if record and record.result.get("packet"):
                return deepcopy(record.result["packet"])

            if args.get("expected_revision") and source["revision"] != args["expected_revision"]:
                raise ConflictError("Session revision changed")

            if (
                source["status"] in {"queued", "running", "pending_approval", "waiting_input", "waiting_external", "waiting_automation"}
                and args.get("workspace_mode") == "current_files"
            ):
                raise ConflictError("Workspace capture requires an inactive canonical source run")

            transfer = None
            if args.get("workspace_mode") == "current_files":
                from homun.application.session_workspace import prepare as prepare_workspace
                transfer = prepare_workspace(ctx, store, actor, work_id, source, args)
                if transfer:
                    transfer["cross_profile"] = True

            from homun.application.session_manager import redact_secrets
            sanitized_messages = []
            for row in source.get("messages", []):
                msg_copy = deepcopy(row["message"])
                if isinstance(msg_copy.get("content"), str):
                    msg_copy["content"] = redact_secrets(msg_copy["content"])
                sanitized_messages.append({"id": row["id"], "message": msg_copy, "turn_index": row.get("turn_index")})

            raw_prefs = source.get("runtime_preferences") or {}
            runtime_prefs = {k: raw_prefs[k] for k in ("connection_id", "provider_id", "model_id") if k in raw_prefs}
            prop_opts = args.get("proposal") or {}
            if prop_opts.get("connection_id"):
                runtime_prefs["connection_id"] = prop_opts["connection_id"]
            if prop_opts.get("model"):
                runtime_prefs["model_id"] = prop_opts["model"]

            source_profile = getattr(ctx, "profile_name", "default")
            digest_payload = {
                "source_profile": source_profile,
                "source_work_id": work_id,
                "source_session_id": source["id"],
                "source_revision": source["revision"],
                "target_profile": target_profile,
                "instruction": instruction.strip(),
                "messages": sanitized_messages,
                "workspace_mode": args.get("workspace_mode", "history_only"),
                "workspace_transfer": transfer,
                "runtime_preferences": runtime_prefs,
            }
            handoff_digest = _compute_handoff_digest(digest_payload)
            target_actor = args.get("target_actor")
            target_actor_id = getattr(target_actor, "id", args.get("target_actor_id"))

            packet = {
                "version": 1,
                "handoff_id": command_id,
                "handoff_digest": handoff_digest,
                "status": "prepared",
                "source_profile": source_profile,
                "source_workspace_id": ctx.workspace_id,
                "source_work_id": work_id,
                "source_session_id": source["id"],
                "source_revision": source["revision"],
                "target_profile": target_profile,
                "target_work_id": args.get("target_work_id"),
                "target_actor_id": target_actor_id,
                "instruction": instruction.strip(),
                "messages": sanitized_messages,
                "workspace_mode": args.get("workspace_mode", "history_only"),
                "runtime_preferences": runtime_prefs,
                "workspace_transfer": transfer,
                "provenance": f"handoff:{source_profile}:{source['id']}:{source['revision']}",
                "created_at": time.time(),
            }

            save(store, actor, command_id, "session.handoff", fingerprint, {"work_id": work_id, "packet": packet, "status": "prepared"})
            ctx.service.store = store

    return packet


def accept_handoff(
    target_ctx: Any,
    target_actor: Any,
    target_work_id: str,
    packet: Dict[str, Any],
    args: Optional[Dict[str, Any]] = None,
    *,
    live_source_ctx: Optional[Any] = None,
    source_actor: Optional[Any] = None,
) -> Dict[str, Any]:
    """Accept handoff packet in target context, verifying two-sided authority and local connections."""
    args = args or {}
    handoff_id = packet.get("handoff_id")
    if not handoff_id or not isinstance(handoff_id, str):
        raise ValidationError("Invalid handoff packet: missing handoff_id")

    if _compute_handoff_digest(packet) != packet.get("handoff_digest"):
        raise ConflictError("Handoff digest conflict: packet corrupted or tampered")

    if live_source_ctx is not None:
        src_actor = source_actor or args.get("source_actor") or target_actor
        live_store = live_source_ctx.repository.load()
        require_work_access(live_store, src_actor, packet["source_work_id"], "read")
        live_source = session_history.lookup(live_store, src_actor, packet["source_work_id"], packet["source_session_id"])
        if live_source["revision"] != packet["source_revision"]:
            raise ConflictError("Live source session revision conflict")
    else:
        packet = deepcopy(packet)
        packet["provenance"] = "handoff-untrusted"

    target_conn_id = (args.get("proposal") or {}).get("connection_id") or packet.get("runtime_preferences", {}).get("connection_id")
    if target_conn_id:
        try:
            conn = target_ctx.models.get_connection(target_conn_id)
            if not getattr(conn, "active", True):
                raise ConflictError(f"Target profile does not authorize connection '{target_conn_id}'")
        except Exception as exc:
            if isinstance(exc, ConflictError):
                raise
            raise ConflictError(f"Target profile does not authorize connection '{target_conn_id}'") from exc

    with target_ctx.repository.locked():
        with target_ctx.repository.transaction() as target_store:
            target_work = require_work_access(target_store, target_actor, target_work_id, "write")
            if target_actor.kind == "person" and target_actor.id not in {target_work.owner_id, target_work.reviewer_id}:
                raise PermissionDeniedError("Only the human owner or reviewer can accept a continuation in target work")

            cached_rec = target_store.commands.get(handoff_id)
            if cached_rec and cached_rec.type == "session.handoff" and cached_rec.result.get("proposal"):
                return deepcopy(cached_rec.result)

            transfer = packet.get("workspace_transfer")
            if transfer:
                transfer = deepcopy(transfer)
                transfer["cross_profile"] = True
                manifest = transfer["manifest"]
                if live_source_ctx and live_source_ctx.data_dir != target_ctx.data_dir:
                    from homun.application.session_workspace_capture import blob_root, _publish_blob, read_blob
                    target_blobs = blob_root(target_ctx.data_dir)
                    for entry in manifest["files"]:
                        _publish_blob(target_blobs, entry["sha256"], read_blob(live_source_ctx.data_dir, entry))

            snapshot_id = handoff_id + ":snapshot"
            snapshot_rec = {
                "id": snapshot_id,
                "work_id": target_work_id,
                "status": "snapshot",
                "operation": "handoff",
                "title": f"Handoff from {packet['source_profile']} ({packet['source_session_id']})",
                "parent_id": None,
                "messages": packet["messages"],
                "sources": [],
                "materials": [],
                "provenance": packet.get("provenance", "handoff-untrusted"),
            }
            save(target_store, target_actor, snapshot_id, session_history.SNAPSHOT, snapshot_id, snapshot_rec)

            from pydantic import ValidationError as SchemaError
            try:
                proposal_input = {**((args.get("proposal") or {})), "command_id": handoff_id + ":proposal", "expected_version": 1}
                if not proposal_input.get("terminal_backend"):
                    proposal_input["terminal_backend"] = "local"
                options = RunRequest.model_validate(proposal_input).model_dump()
            except (SchemaError, TypeError) as exc:
                raise ValidationError("Invalid continuation proposal options") from exc

            from homun.application.session_records import revision as calculate_revision
            target_snapshot_revision = calculate_revision(snapshot_rec["messages"])

            body = {
                **options,
                "session_context": {
                    "session_id": snapshot_id,
                    "work_id": target_work_id,
                    "revision": target_snapshot_revision,
                    "instruction": packet["instruction"],
                },
            }
            if transfer:
                body["workspace_transfer"] = {"command_id": handoff_id, "digest": transfer["digest"]}

            save(target_store, target_actor, handoff_id, "session.handoff", handoff_id, {
                "target_work_id": target_work_id,
                "proposal_body": body,
                "workspace_transfer": transfer,
                "status": "proposed",
                "handoff_id": handoff_id,
            })
            target_ctx.service.store = target_store

    proposal = target_ctx.session_operations.propose(target_ctx, target_actor, target_work_id, body)
    result = {
        "status": "proposed",
        "handoff_id": handoff_id,
        "target_profile": packet["target_profile"],
        "target_work_id": target_work_id,
        "proposal": proposal,
        "requires_fresh_approval": True,
    }

    with target_ctx.repository.locked():
        with target_ctx.repository.transaction() as target_store:
            target_store.commands[handoff_id].result["proposal"] = proposal
            target_ctx.service.store = target_store

    return result


def execute_handoff(ctx: Any, actor: Any, work_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Orchestrate cross-profile handoff keeping the global active profile unchanged."""
    target_profile = args.get("target_profile")
    if not target_profile:
        session = session_history.lookup(ctx.repository.load(), actor, work_id, args.get("session_id", ""))
        return {"status": "prepared", "session": session, "requires_fresh_approval": True}

    profiles_dir = ctx.data_dir / "profiles"
    profile_mgr = None
    active_before = None
    if profiles_dir.exists():
        from homun.application.profile_operations import ProfileOperationsManager
        profile_mgr = ProfileOperationsManager(profiles_dir)
        active_before = profile_mgr.get_active_profile_name()

    resolver = (
        getattr(ctx, "profile_context_resolver", None)
        or args.get("profile_context_resolver")
        or (lambda name: default_profile_context_resolver(ctx, name))
    )
    target_ctx = resolver(target_profile)

    phase = args.get("phase")
    try:
        if phase == "prepare":
            return prepare_handoff(ctx, actor, work_id, args)

        if phase == "accept":
            packet = args.get("handoff_packet")
            if not packet or not isinstance(packet, dict):
                raise ValidationError("handoff_packet is required for accept phase")
            target_actor = args.get("target_actor") or actor
            target_work_id = args.get("target_work_id") or packet.get("target_work_id")
            if not target_work_id:
                raise ValidationError("target_work_id is required for accept phase")
            return accept_handoff(
                target_ctx, target_actor, target_work_id, packet, args,
                live_source_ctx=ctx if args.get("live_source", True) else None,
                source_actor=actor,
            )

        packet = prepare_handoff(ctx, actor, work_id, args)
        target_actor = args.get("target_actor") or actor
        target_work_id = args.get("target_work_id")
        if not target_work_id:
            with target_ctx.repository.locked():
                with target_ctx.repository.transaction() as target_store:
                    svc = target_ctx.service.for_store(target_store)
                    owner_id = getattr(target_actor, "id", "owner")
                    proj = svc.apply(target_actor, f"handoff-proj-{packet['handoff_id']}", "project.create", {"name": f"Project for {target_profile}"})
                    conv = svc.apply(target_actor, f"handoff-conv-{packet['handoff_id']}", "conversation.create", {"project_id": proj["project_id"], "title": "Handoff Conv"})
                    created_work = svc.apply(target_actor, f"handoff-work-{packet['handoff_id']}", "work.create", {
                        "conversation_id": conv["conversation_id"],
                        "title": f"Handoff from {packet['source_profile']}",
                        "objective": packet["instruction"],
                        "owner_id": owner_id,
                        "reviewer_id": owner_id,
                    })
                    target_work_id = created_work["work_id"]
                    target_ctx.service.store = target_store

        return accept_handoff(
            target_ctx, target_actor, target_work_id, packet, args,
            live_source_ctx=ctx if args.get("live_source", True) else None,
            source_actor=actor,
        )
    finally:
        if profile_mgr and active_before is not None:
            assert profile_mgr.get_active_profile_name() == active_before, "Global active profile must not change during cross-profile transfer"
