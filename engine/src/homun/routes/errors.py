"""Public transport errors do not expose storage internals."""
from homun.storage.errors import StorageError
from fastapi import Request
from fastapi.responses import JSONResponse


def storage_error_payload() -> dict[str, str]:
    return {"code": "storage_unavailable", "message": "Workspace storage is unavailable; retry after checking engine status"}


async def storage_error_handler(_request: Request, _exc: StorageError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": storage_error_payload()})
