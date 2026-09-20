"""Application factory for the Homun engine."""

from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from homun import __version__
from homun import context as context_mod
from homun.context import create_context, get_context, reset_context_for_tests
from homun.routes import backup, capabilities, domain, health, material_reads, memory, models, price_comparisons, intake, tool_chains
from homun.routes.errors import storage_error_handler

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    from homun.storage.lease import engine_lease
    from homun.application.lifecycle import runtime_lifespan
    from homun.application.material_ingest import recover_materials
    from homun.storage.paths import default_data_dir
    owns_context = context_mod._CONTEXT is None
    root = default_data_dir() if owns_context else context_mod._CONTEXT.data_dir
    with engine_lease(root):
        try:
            if owns_context:
                reset_context_for_tests(create_context())
            ctx = get_context()
            recover_materials(ctx)
            async with runtime_lifespan(ctx):
                yield
        finally:
            if owns_context:
                reset_context_for_tests(None)


def create_app(*, session_token: str | None = None, allowed_origins: list[str] | None = None,
               session_actor_id: str = "person_fabio") -> FastAPI:
    app = FastAPI(
        title="Homun Engine",
        version=__version__,
        description="Local Homun 2 engine — domain F2 over SQLite + HTTP.",
        lifespan=lifespan,
    )
    app.add_exception_handler(sqlite3.Error, storage_error_handler)
    app.add_exception_handler(OSError, storage_error_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins if allowed_origins is not None else ["http://127.0.0.1:4183", "http://localhost:4183"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    if session_token:
        from homun.routes.session_auth import SessionAuthMiddleware
        app.add_middleware(SessionAuthMiddleware, token=session_token, origins=allowed_origins or [], actor_id=session_actor_id)
    app.include_router(health.router)
    app.include_router(domain.router)
    app.include_router(price_comparisons.router)
    app.include_router(material_reads.router)
    app.include_router(tool_chains.router)
    app.include_router(intake.router)
    app.include_router(capabilities.router)
    app.include_router(backup.router)
    app.include_router(models.router)
    app.include_router(memory.router)
    return app
