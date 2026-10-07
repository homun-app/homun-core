"""Computer-use readiness for installers and onboarding UI."""
import platform

from fastapi import APIRouter, Header

from homun.application import computer_use_backend
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/computer-use", tags=["computer-use"])


@router.get("/status")
def computer_use_status(workspace_id: str,
                        x_homun_actor_id: str | None = Header(default=None),
                        x_homun_actor_name: str | None = Header(default=None)):
    request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    binary = computer_use_backend.resolve_binary()
    system = platform.system()
    notes = {
        "Darwin": ("Servono i permessi TCC (Accessibilità + Registrazione schermo) "
                   "concessi all'identità del driver."),
        "Windows": "Nessun permesso speciale: pronto quando il driver risponde.",
        "Linux": ("Serve un desktop: X11 richiede DISPLAY, Wayland va abilitato "
                  "via env del driver; l'albero di accessibilità arriva da AT-SPI."),
    }
    return {
        "available": binary is not None,
        "binary": binary,
        "platform": system,
        "platform_note": notes.get(system, "Piattaforma non certificata per il driver."),
        "install_hint": None if binary else computer_use_backend.INSTALL_HINT,
    }
