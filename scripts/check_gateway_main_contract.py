#!/usr/bin/env python3
"""Guard the desktop gateway `main.rs` ownership boundary.

This is intentionally structural, not semantic. It prevents previously
extracted startup owners from being pasted back into `async fn main`, while
still allowing their implementation details to keep moving behind dedicated
modules.
"""
from __future__ import annotations

import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "main.rs")


def extract_async_main_body(source: str) -> str:
    marker = "async fn main()"
    start = source.find(marker)
    if start < 0:
        raise AssertionError("missing async fn main()")
    open_brace = source.find("{", start)
    if open_brace < 0:
        raise AssertionError("async fn main() has no body")

    depth = 0
    for index in range(open_brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_brace + 1 : index]
    raise AssertionError("async fn main() body is not balanced")


def forbidden_main_startup_snippets() -> dict[str, str]:
    return {
        "init_active_workspace_from_disk();": "active workspace boot must stay in gateway_boot_maintenance",
        "seed_default_skills();": "skill seeding must stay in gateway_boot_maintenance",
        "gc_stale_tasks(&state);": "stale task GC must stay in gateway_boot_maintenance",
        "backfill_contacts(&state);": "contact backfill must stay in gateway_boot_maintenance",
        "backfill_mentions(&state);": "mention backfill must stay in gateway_boot_maintenance",
        "unify_owner_identity(&state);": "owner identity unification must stay in gateway_boot_maintenance",
        "cancel_homun_checkins(&state);": "retired Homun check-ins must stay in gateway_boot_maintenance",
        "projection_worker::drain_at_startup(&state,": "projection replay must stay in gateway_turn_recovery",
        "local_first_task_runtime::broker::recover_chat_turns_at_boot(": "broker recovery must stay in gateway_turn_recovery",
        "set_chat_turn_message_delivery_state(\n            &state,": "recovered message repair must stay in gateway_turn_recovery",
        "projection_worker::start(state.clone());": "projection worker startup must stay in gateway_turn_recovery",
        "steering_control::start(state.clone());": "steering startup must stay in gateway_turn_recovery",
        "sweep_stale_dated_suggestions_once(&st).await": "stale suggestion sweep must stay in gateway_background_startup",
        "sweep_graph_on_startup(&st)": "graph startup sweep must stay in gateway_background_startup",
        "vacuum_all_stores(&st);": "startup VACUUM must stay in gateway_background_startup",
        "start_task_executor_worker(state.clone());": "task worker startup must stay in gateway_background_startup",
        "spawn_memory_consolidation_tick(state.clone());": "memory consolidation must stay in gateway_background_startup",
        "spawn_embedding_catchup(state.clone());": "embedding catchup must stay in gateway_background_startup",
        "spawn_memory_hygiene_sweep(state.clone());": "memory hygiene must stay in gateway_background_startup",
        "spawn_thread_browser_session_reaper(state.clone());": "thread browser session reaper must stay in gateway_background_startup",
        "spawn_contained_computer_idle_reaper(state.clone());": "contained computer reaper must stay in gateway_background_startup",
        "spawn_browser_handoff_reaper(state.clone());": "browser handoff reaper must stay in gateway_background_startup",
        "spawn_connector_event_poller(state.clone());": "connector event poller must stay in gateway_background_startup",
        "start_proactivity_auto_review(state.clone());": "proactivity auto-review must stay in gateway_background_startup",
        "spawn_computer_live_publisher(state.clone());": "computer live publisher must stay in gateway_background_startup",
        "let chat_routes = Router::new()": "route assembly must stay in gateway_routes",
        "let chat_routes = chat_routes": "route layering must stay in gateway_routes",
        "let mut app = Router::new()": "top-level app router assembly must stay in gateway_routes",
        "app = app.fallback_service(": "web fallback mounting must stay in gateway_routes",
        "let app = app.layer(gateway_cors::cors_layer());": "CORS layering must stay in gateway_routes",
    }


def assert_contains(source: str, snippet: str, message: str) -> None:
    if snippet not in source:
        raise AssertionError(f"{message}: missing {snippet!r}")


def assert_not_contains(source: str, snippet: str, message: str) -> None:
    if snippet in source:
        raise AssertionError(f"{message}: found {snippet!r}")


def assert_ordered(source: str, snippets: list[str], message: str) -> None:
    cursor = -1
    for snippet in snippets:
        index = source.find(snippet, cursor + 1)
        if index < 0:
            raise AssertionError(f"{message}: missing {snippet!r}")
        if index <= cursor:
            raise AssertionError(f"{message}: {snippet!r} is out of order")
        cursor = index


def main() -> int:
    with open(MAIN_RS, "r", encoding="utf-8") as handle:
        source = handle.read()
    main_body = extract_async_main_body(source)

    required_owner_calls = [
        "gateway_boot_maintenance::run_gateway_boot_maintenance(&state);",
        "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;",
        "gateway_background_startup::start_gateway_background_services(state.clone());",
        "let app = gateway_routes::build_gateway_router(state.clone());",
    ]
    for snippet in required_owner_calls:
        assert_contains(main_body, snippet, "async fn main must delegate startup ownership")

    for snippet, message in forbidden_main_startup_snippets().items():
        assert_not_contains(main_body, snippet, message)

    assert_ordered(
        main_body,
        [
            "gateway_file_security::harden_data_at_rest(&dir);",
            "gateway_boot_maintenance::run_gateway_boot_maintenance(&state);",
            "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;",
            "gateway_background_startup::start_gateway_background_services(state.clone());",
            "let app = gateway_routes::build_gateway_router(state.clone());",
            "let computer_warmup_state = startup_state.clone();",
        ],
        "async fn main startup order must keep critical recovery before background work",
    )

    print("gateway main ownership contract passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"gateway main ownership contract failed: {error}", file=sys.stderr)
        raise SystemExit(1)
