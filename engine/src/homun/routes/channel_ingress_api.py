from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timezone
import asyncio
import json
import os
import threading
import time
import uuid
import httpx
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from homun.application.channel_adapters import ChannelRegistry
from homun.application.channel_conversation_bridge import channel_reply
from homun.application.channel_delivery_recovery import ChannelPoller, get_channel_delivery_supervisor
from homun.application.channel_inbound_queue import InboundChannelQueue, get_inbound_channel_queue

router = APIRouter(prefix="/v1/gateway/channels", tags=["gateway_channels"])

_GLOBAL_CHANNEL_REGISTRY: Optional[ChannelRegistry] = None


def get_channel_registry() -> ChannelRegistry:
    global _GLOBAL_CHANNEL_REGISTRY
    if _GLOBAL_CHANNEL_REGISTRY is None:
        _GLOBAL_CHANNEL_REGISTRY = ChannelRegistry(
            inbound_queue=get_inbound_channel_queue(),
            delivery_supervisor=get_channel_delivery_supervisor(),
        )
        # Apply any saved configurations from disk
        saved = _load_channels_config()
        for pid, pcfg in saved.items():
            _apply_channel_to_adapter(pid, pcfg)
    return _GLOBAL_CHANNEL_REGISTRY


def reset_channel_registry() -> None:
    global _GLOBAL_CHANNEL_REGISTRY
    _GLOBAL_CHANNEL_REGISTRY = None


class RecoverQueueResponse(BaseModel):
    recovered_count: int


class PlatformConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    fields: Dict[str, str] = Field(default_factory=dict)


class PlatformTestRequest(BaseModel):
    fields: Dict[str, str] = Field(default_factory=dict)


def _channels_config_path() -> Path:
    from homun.context import get_context
    ctx = get_context()
    return ctx.data_dir / "channels.json"


def _load_channels_config() -> Dict[str, Any]:
    path = _channels_config_path()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_channels_config(cfg: Dict[str, Any]) -> None:
    path = _channels_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _apply_channel_to_adapter(platform_id: str, channel_data: Dict[str, Any]) -> None:
    global _GLOBAL_CHANNEL_REGISTRY
    if _GLOBAL_CHANNEL_REGISTRY is None:
        return
    adapter = _GLOBAL_CHANNEL_REGISTRY.get_adapter(platform_id)
    if not adapter:
        return
    fields = channel_data.get("fields") or {}
    if not hasattr(adapter, "config") or not isinstance(adapter.config, dict):
        adapter.config = {}
    adapter.config.update(fields)
    if "bot_token" in fields:
        plat_upper = platform_id.upper().replace("-", "_")
        adapter.config[f"{plat_upper}_BOT_TOKEN"] = fields["bot_token"]
        if platform_id == "slack":
            adapter.config["SLACK_BOT_TOKEN"] = fields["bot_token"]
    if "app_token" in fields:
        adapter.config["SLACK_APP_TOKEN"] = fields["app_token"]
    if "server_url" in fields:
        adapter.config["server"] = fields["server_url"]
        adapter.config["server_url"] = fields["server_url"]
    if "homeserver" in fields:
        adapter.config["homeserver"] = fields["homeserver"]
    if "access_token" in fields:
        adapter.config["MATRIX_ACCESS_TOKEN"] = fields["access_token"]
        adapter.config["access_token"] = fields["access_token"]
    if "allowed_user_ids" in fields and fields["allowed_user_ids"].strip():
        adapter.config["allowed_users"] = [x.strip() for x in fields["allowed_user_ids"].split(",") if x.strip()]
    else:
        adapter.config["allowed_users"] = []


@router.get("/platforms", response_model=Dict[str, Any])
def list_channel_platforms() -> Dict[str, Any]:
    saved = _load_channels_config()
    registry = get_channel_registry()
    items = []
    for platform_id in sorted(registry._adapters.keys()):
        adapter = registry._adapters[platform_id]
        if platform_id in ("msgraph_webhook", "open-webui", "teams-meetings", "wecom-callback", "whatsapp-cloud"):
            continue
        cfg = saved.get(platform_id) or {}
        fields = cfg.get("fields") or {}
        masked_fields = {}
        for k, v in fields.items():
            if ("token" in k or "secret" in k or "key" in k or "password" in k) and len(v) > 6:
                masked_fields[k] = v[:3] + "•••" + v[-3:]
            else:
                masked_fields[k] = v
        enabled = bool(cfg.get("enabled", False))
        configured = bool(fields and any(v.strip() for v in fields.values()))
        state = "connected" if (enabled and configured) else ("needs_setup" if configured else "disabled")
        items.append({
            "id": platform_id,
            "name": adapter.platform.capitalize(),
            "enabled": enabled,
            "configured": configured,
            "state": state,
            "fields": dict(fields),
            "masked_fields": masked_fields,
            "has_secrets": bool(fields),
        })
    return {"platforms": items}


@router.put("/platforms/{platform_id}", response_model=Dict[str, Any])
@router.post("/platforms/{platform_id}", response_model=Dict[str, Any])
def update_channel_platform(platform_id: str, body: PlatformConfigRequest) -> Dict[str, Any]:
    plat = platform_id.strip().lower()
    saved = _load_channels_config()
    current = saved.get(plat) or {"enabled": False, "fields": {}}
    if body.enabled is not None:
        current["enabled"] = body.enabled
    if body.fields:
        cur_fields = current.get("fields") or {}
        for k, v in body.fields.items():
            if "•••" in v:
                continue
            cur_fields[k] = v
        current["fields"] = cur_fields
    saved[plat] = current
    _save_channels_config(saved)
    _apply_channel_to_adapter(plat, current)
    return {"ok": True, "platform": plat, "enabled": current.get("enabled", False)}


@router.delete("/platforms/{platform_id}", response_model=Dict[str, Any])
def delete_channel_platform(platform_id: str) -> Dict[str, Any]:
    """Remove a platform configuration: saved fields are deleted and the live
    adapter is cleared so polling stops without an engine restart."""
    plat = platform_id.strip().lower()
    saved = _load_channels_config()
    if plat not in saved:
        raise HTTPException(
            status_code=404,
            detail={"code": "channel_platform_not_configured", "message": f"Platform '{plat}' has no saved configuration."},
        )
    del saved[plat]
    _save_channels_config(saved)
    registry = get_channel_registry()
    adapter = registry.get_adapter(plat)
    if adapter is not None and isinstance(getattr(adapter, "config", None), dict):
        adapter.config.clear()
    return {"ok": True, "platform": plat}


KNOWN_PLATFORMS = {
    "telegram", "discord", "slack", "whatsapp", "whatsapp_cloud", "signal", "matrix",
    "mattermost", "bluebubbles", "homeassistant", "email", "sms",
    "googlechat", "dingtalk", "feishu", "wecom", "qqbot", "yuanbao", "irc"
}


@router.post("/platforms/{platform_id}/test", response_model=Dict[str, Any])
def test_channel_platform(platform_id: str, body: Optional[PlatformTestRequest] = None) -> Dict[str, Any]:
    plat = platform_id.strip().lower()
    if plat not in KNOWN_PLATFORMS:
        return {"ok": False, "message": f"Piattaforma '{platform_id}' non riconosciuta"}
    saved = _load_channels_config()
    cfg = saved.get(plat) or {}
    fields = dict(cfg.get("fields") or {})
    if body and body.fields:
        for k, v in body.fields.items():
            if "•••" not in v:
                fields[k] = v

    if plat == "telegram":
        token = fields.get("bot_token") or os.environ.get("TELEGRAM_BOT_TOKEN")
        if not token:
            return {"ok": False, "message": "Nessun Bot Token fornito per Telegram."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(f"https://api.telegram.org/bot{token}/getMe")
            data = resp.json() if resp.content else {}
            if resp.status_code == 200 and data.get("ok"):
                res = data.get("result") or {}
                username = res.get("username", "bot")
                first_name = res.get("first_name", "")
                return {"ok": True, "message": f"Connesso al bot Telegram @{username} ({first_name})."}
            err = data.get("description") or f"HTTP {resp.status_code}"
            return {"ok": False, "message": f"Telegram ha rifiutato il token: {err}"}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile contattare Telegram: {exc}"}

    elif plat == "discord":
        token = fields.get("bot_token") or os.environ.get("DISCORD_BOT_TOKEN")
        if not token:
            return {"ok": False, "message": "Nessun Bot Token fornito per Discord."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get("https://discord.com/api/v10/users/@me", headers={"Authorization": f"Bot {token}"})
            if resp.status_code == 200:
                data = resp.json()
                username = data.get("username", "bot")
                return {"ok": True, "message": f"Connesso al bot Discord '{username}'."}
            return {"ok": False, "message": f"Discord ha rifiutato il token (HTTP {resp.status_code})."}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile contattare Discord: {exc}"}

    elif plat == "slack":
        token = fields.get("bot_token") or os.environ.get("SLACK_BOT_TOKEN")
        if not token:
            return {"ok": False, "message": "Nessun Bot Token (xoxb-...) fornito per Slack."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post("https://slack.com/api/auth.test", headers={"Authorization": f"Bearer {token}"})
            data = resp.json() if resp.content else {}
            if resp.status_code == 200 and data.get("ok"):
                team = data.get("team", "")
                user = data.get("user", "")
                return {"ok": True, "message": f"Connesso a Slack: workspace '{team}', bot @{user}."}
            err = data.get("error") or f"HTTP {resp.status_code}"
            return {"ok": False, "message": f"Slack ha rifiutato il token: {err}"}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile contattare Slack: {exc}"}

    elif plat == "homeassistant":
        url = fields.get("server_url") or "http://homeassistant.local:8123"
        token = fields.get("access_token")
        if not token:
            return {"ok": False, "message": "Nessun Access Token fornito per Home Assistant."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(f"{url.rstrip('/')}/api/", headers={"Authorization": f"Bearer {token}"})
            if resp.status_code == 200:
                return {"ok": True, "message": "Connesso all'API di Home Assistant con successo."}
            return {"ok": False, "message": f"Home Assistant ha risposto con HTTP {resp.status_code}."}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile raggiungere Home Assistant: {exc}"}

    elif plat == "matrix":
        homeserver = fields.get("homeserver") or "https://matrix.org"
        token = fields.get("access_token")
        if not token:
            return {"ok": False, "message": "Nessun Access Token fornito per Matrix."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(f"{homeserver.rstrip('/')}/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {token}"})
            if resp.status_code == 200:
                uid = resp.json().get("user_id", "")
                return {"ok": True, "message": f"Connesso a Matrix come {uid}."}
            return {"ok": False, "message": f"Matrix ha risposto con HTTP {resp.status_code}."}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile raggiungere Matrix: {exc}"}

    elif plat == "whatsapp":
        # Personal-account path: the local wa-rs-bridge sidecar owns the session.
        adapter = get_channel_registry().get_adapter("whatsapp")
        if adapter is None or not hasattr(adapter, "bridge_status"):
            return {"ok": False, "message": "Adattatore WhatsApp bridge non registrato nel motore."}
        status = adapter.bridge_status()
        if status is None:
            return {"ok": False, "message": f"wa-rs-bridge non raggiungibile su {adapter.bridge_url()}. Avvia il sidecar e riprova."}
        if status.get("logged_out"):
            return {"ok": False, "message": "La sessione WhatsApp è stata scollegata da questo telefono. Riavvia il pairing."}
        if status.get("paired"):
            return {"ok": True, "message": f"Sessione WhatsApp attiva ({status.get('jid')})."}
        return {"ok": False, "message": "Bridge raggiungibile ma nessuna sessione collegata: completa il pairing dal QR."}

    elif plat == "whatsapp_cloud":
        token = fields.get("api_token") or os.environ.get("WHATSAPP_API_TOKEN")
        phone_id = fields.get("phone_number_id") or os.environ.get("WHATSAPP_PHONE_NUMBER_ID")
        if not token or not phone_id:
            return {"ok": False, "message": "Inserisci sia Phone Number ID che Access Token per testare WhatsApp Cloud API."}
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(
                    f"https://graph.facebook.com/v19.0/{phone_id.strip()}",
                    headers={"Authorization": f"Bearer {token.strip()}"},
                )
            if resp.status_code == 200:
                data = resp.json()
                verified_name = data.get("verified_name") or data.get("display_phone_number") or phone_id
                return {"ok": True, "message": f"Connesso all'API WhatsApp Cloud per '{verified_name}'."}
            err = resp.json().get("error", {}).get("message", f"HTTP {resp.status_code}")
            return {"ok": False, "message": f"Meta WhatsApp API ha risposto con errore: {err}"}
        except Exception as exc:
            return {"ok": False, "message": f"Impossibile contattare Meta WhatsApp API: {exc}"}

    else:
        has_any = any(v.strip() for v in fields.values())
        if has_any:
            return {"ok": True, "message": f"Configurazione salvata per l'adattatore {plat}."}
        return {"ok": False, "message": "Compila i campi richiesti prima di testare la connessione."}


# ── Telegram Automated QR Onboarding ─────────────────────────────────

_TELEGRAM_ONBOARDING_URL = os.getenv("TELEGRAM_ONBOARDING_URL", "https://gateway.homun.app").strip().rstrip("/")


@dataclass
class _TelegramOnboardingPairing:
    poll_token: str
    expires_at: str
    expires_at_ts: float
    bot_token: Optional[str] = None
    bot_username: Optional[str] = None
    owner_user_id: Optional[str] = None


_telegram_onboarding_pairings: Dict[str, _TelegramOnboardingPairing] = {}
_telegram_onboarding_lock = threading.RLock()


def _prune_telegram_pairings() -> None:
    now = time.time()
    expired = [k for k, v in _telegram_onboarding_pairings.items() if v.expires_at_ts <= now]
    for k in expired:
        _telegram_onboarding_pairings.pop(k, None)


class TelegramOnboardingStart(BaseModel):
    bot_name: Optional[str] = "Homun Agent"


class TelegramOnboardingApply(BaseModel):
    allowed_user_ids: Optional[List[str]] = None


@router.post("/telegram/onboarding/start", response_model=Dict[str, Any])
async def start_telegram_onboarding(body: Optional[TelegramOnboardingStart] = None) -> Dict[str, Any]:
    bot_name = (body.bot_name if body and body.bot_name else "Homun Agent").strip() or "Homun Agent"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{_TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings",
                json={"bot_name": bot_name},
                headers={
                    "Accept": "application/json",
                    "User-Agent": "HomunDashboard/0.2.1",
                },
            )
        if resp.status_code not in (200, 201):
            _log.warning("Telegram onboarding start failed (%d): %s", resp.status_code, resp.text)
            raise HTTPException(
                status_code=502,
                detail=f"Servizio di configurazione Telegram non disponibile (HTTP {resp.status_code}).",
            )
        data = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Errore connessione onboarding Telegram: {exc}")

    pairing_id = str(data.get("pairing_id") or "").strip()
    poll_token = str(data.get("poll_token") or "").strip()
    expires_at = str(data.get("expires_at") or "").strip()
    deep_link = str(data.get("deep_link") or "").strip()
    qr_payload = str(data.get("qr_payload") or deep_link).strip()
    if not pairing_id or not poll_token:
        raise HTTPException(status_code=502, detail="Risposta incompleta dal servizio di onboarding.")

    with _telegram_onboarding_lock:
        _prune_telegram_pairings()
        _telegram_onboarding_pairings[pairing_id] = _TelegramOnboardingPairing(
            poll_token=poll_token,
            expires_at=expires_at,
            expires_at_ts=time.time() + 1800.0,
        )

    return {
        "pairing_id": pairing_id,
        "deep_link": deep_link,
        "qr_payload": qr_payload,
        "expires_at": expires_at,
        "suggested_username": data.get("suggested_username"),
    }


@router.get("/telegram/onboarding/{pairing_id}", response_model=Dict[str, Any])
async def get_telegram_onboarding_status(pairing_id: str) -> Dict[str, Any]:
    with _telegram_onboarding_lock:
        _prune_telegram_pairings()
        record = _telegram_onboarding_pairings.get(pairing_id)
        if not record:
            raise HTTPException(status_code=404, detail="Sessione di accoppiamento Telegram non trovata.")
        if record.bot_token:
            return {
                "status": "ready",
                "bot_username": record.bot_username,
                "owner_user_id": record.owner_user_id,
                "expires_at": record.expires_at,
            }
        poll_token = record.poll_token

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{_TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings/{pairing_id}",
                headers={
                    "Authorization": f"Bearer {poll_token}",
                    "Accept": "application/json",
                    "User-Agent": "HomunDashboard/0.2.1",
                },
            )
    except Exception:
        return {"status": "waiting", "expires_at": record.expires_at}

    if resp.status_code in {404, 410}:
        with _telegram_onboarding_lock:
            _telegram_onboarding_pairings.pop(pairing_id, None)
        raise HTTPException(status_code=410, detail="Accoppiamento Telegram scaduto o già utilizzato.")

    if resp.status_code != 200:
        return {"status": "waiting", "expires_at": record.expires_at}

    data = resp.json()
    status = str(data.get("status") or "").strip()
    if status == "ready":
        token = str(data.get("token") or "").strip()
        bot_uname = str(data.get("bot_username") or "").strip()
        owner_id = str(data.get("owner_user_id") or "").strip()
        with _telegram_onboarding_lock:
            record = _telegram_onboarding_pairings.get(pairing_id)
            if record:
                record.bot_token = token
                record.bot_username = bot_uname
                record.owner_user_id = owner_id
        return {
            "status": "ready",
            "bot_username": bot_uname,
            "owner_user_id": owner_id,
            "expires_at": data.get("expires_at", record.expires_at),
        }

    if status in {"expired", "claimed"}:
        with _telegram_onboarding_lock:
            _telegram_onboarding_pairings.pop(pairing_id, None)
        raise HTTPException(status_code=410, detail="Accoppiamento Telegram scaduto o già utilizzato.")

    return {"status": "waiting", "expires_at": record.expires_at}


@router.post("/telegram/onboarding/{pairing_id}/apply", response_model=Dict[str, Any])
def apply_telegram_onboarding(pairing_id: str, body: Optional[TelegramOnboardingApply] = None) -> Dict[str, Any]:
    with _telegram_onboarding_lock:
        record = _telegram_onboarding_pairings.get(pairing_id)
        if not record or not record.bot_token:
            raise HTTPException(status_code=400, detail="Il bot Telegram non è ancora pronto per essere applicato.")
        token = record.bot_token
        uname = record.bot_username
        owner = record.owner_user_id
        _telegram_onboarding_pairings.pop(pairing_id, None)

    saved = _load_channels_config()
    current = saved.get("telegram") or {"enabled": True, "fields": {}}
    fields = dict(current.get("fields") or {})
    fields["bot_token"] = token
    allowed = body.allowed_user_ids if body and body.allowed_user_ids else ([owner] if owner else [])
    if allowed:
        fields["allowed_user_ids"] = ", ".join(str(u).strip() for u in allowed if str(u).strip())
    current["enabled"] = True
    current["fields"] = fields
    saved["telegram"] = current
    _save_channels_config(saved)
    _apply_channel_to_adapter("telegram", current)
    return {"ok": True, "platform": "telegram", "bot_username": uname, "enabled": True, "fields": fields}


@router.delete("/telegram/onboarding/{pairing_id}", response_model=Dict[str, Any])
def cancel_telegram_onboarding(pairing_id: str) -> Dict[str, Any]:
    with _telegram_onboarding_lock:
        _telegram_onboarding_pairings.pop(pairing_id, None)
    return {"ok": True}


# ── WhatsApp Bridge QR Pairing ────────────────────────────────────────
# The wa-rs-bridge sidecar pairs autonomously at boot; these endpoints
# surface its live QR/status to the app and persist the channel config.

_whatsapp_pairings: Dict[str, Dict[str, Any]] = {}
_whatsapp_pairings_lock = threading.RLock()

_WHATSAPP_PAIRING_WINDOW_SECONDS = 1800.0


def _whatsapp_bridge_adapter():
    from homun.application.whatsapp_bridge_adapter import WhatsAppBridgeAdapter

    adapter = get_channel_registry().get_adapter("whatsapp")
    return adapter if adapter is not None and hasattr(adapter, "bridge_status") else WhatsAppBridgeAdapter()


async def _fresh_whatsapp_bridge_status(adapter):
    """Bridge status with a non-expired QR, recycling our own sidecar.

    The sidecar emits one QR per connection: when the payload is stale (or
    absent while unpaired), the only way to hand back a scannable code is a
    fresh connection. External bridges are reported as-is.
    """
    status = adapter.bridge_status()
    if status is None or status.get("paired") or status.get("logged_out"):
        return status
    qr = status.get("qr") or {}
    expires = _parse_iso_timestamp(qr.get("expires_at"))
    if expires and expires > datetime.now(timezone.utc).timestamp() + 5:
        return status
    from homun.application.whatsapp_bridge_process import restart_whatsapp_bridge

    await asyncio.to_thread(restart_whatsapp_bridge)
    for _ in range(8):
        refreshed = await asyncio.to_thread(adapter.bridge_status)
        if refreshed is not None and (refreshed.get("paired") or (refreshed.get("qr") or {}).get("payload")):
            return refreshed
        await asyncio.sleep(0.75)
    return await asyncio.to_thread(adapter.bridge_status)


def _parse_iso_timestamp(value) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


@router.post("/whatsapp/onboarding/start", response_model=Dict[str, Any])
async def start_whatsapp_onboarding() -> Dict[str, Any]:
    from homun.application.whatsapp_bridge_process import ensure_whatsapp_bridge

    # Pairing precedes configuration: make sure the sidecar is up even when
    # the channel is not enabled yet, with a fresh, non-expired QR.
    ensure_whatsapp_bridge(force=True, allow_unconfigured=True)
    adapter = _whatsapp_bridge_adapter()
    status = await _fresh_whatsapp_bridge_status(adapter)
    if status is None:
        raise HTTPException(
            status_code=502,
            detail={"code": "bridge_unreachable",
                    "message": f"wa-rs-bridge non raggiungibile su {adapter.bridge_url()}. Avvia il sidecar (wa-rs-bridge)."},
        )
    pairing_id = uuid.uuid4().hex[:16]
    record: Dict[str, Any] = {"created_ts": time.time(), "jid": None}
    qr_payload = None
    pair_code = None
    if status.get("paired"):
        record["jid"] = status.get("jid")
    else:
        qr_payload = (status.get("qr") or {}).get("payload")
        pair_code = (status.get("pair_code") or {}).get("code")
    with _whatsapp_pairings_lock:
        expired = [k for k, v in _whatsapp_pairings.items()
                   if time.time() - v["created_ts"] > _WHATSAPP_PAIRING_WINDOW_SECONDS]
        for k in expired:
            _whatsapp_pairings.pop(k, None)
        _whatsapp_pairings[pairing_id] = record
    return {
        "pairing_id": pairing_id,
        "paired": bool(status.get("paired")),
        "qr_payload": qr_payload,
        "pair_code": pair_code,
        "expires_at": datetime.fromtimestamp(
            record["created_ts"] + _WHATSAPP_PAIRING_WINDOW_SECONDS, tz=timezone.utc
        ).isoformat(),
    }


@router.get("/whatsapp/onboarding/{pairing_id}", response_model=Dict[str, Any])
async def get_whatsapp_onboarding_status(pairing_id: str) -> Dict[str, Any]:
    with _whatsapp_pairings_lock:
        record = _whatsapp_pairings.get(pairing_id)
        if not record:
            raise HTTPException(
                status_code=404,
                detail={"code": "pairing_not_found", "message": "Sessione di pairing WhatsApp non trovata."},
            )
        if record.get("jid"):
            return {"status": "ready", "jid": record["jid"]}
        if time.time() - record["created_ts"] > _WHATSAPP_PAIRING_WINDOW_SECONDS:
            _whatsapp_pairings.pop(pairing_id, None)
            raise HTTPException(
                status_code=410,
                detail={"code": "pairing_expired", "message": "Sessione di pairing WhatsApp scaduta."},
            )

    status = await _fresh_whatsapp_bridge_status(_whatsapp_bridge_adapter())
    if status is None:
        return {"status": "waiting"}
    if status.get("paired"):
        jid = status.get("jid")
        lid = status.get("lid")
        with _whatsapp_pairings_lock:
            record = _whatsapp_pairings.get(pairing_id)
            if record is not None:
                record["jid"] = jid
                record["lid"] = lid
        return {"status": "ready", "jid": jid, "lid": lid}
    qr_payload = (status.get("qr") or {}).get("payload")
    pair_code = (status.get("pair_code") or {}).get("code")
    payload: Dict[str, Any] = {"status": "waiting", "qr_payload": qr_payload, "pair_code": pair_code}
    if status.get("last_pair_error"):
        payload["pair_error"] = status["last_pair_error"]
    return payload


def _whatsapp_allowed_ids(jid: Optional[str], lid: Optional[str]) -> List[str]:
    """Both wire identities of the paired account, in the forms senders use.

    A WhatsApp account addresses traffic with its phone Jid or its opaque LID,
    with or without a device suffix; authorizing all observed forms of the
    owner's identities is what makes the self-chat pass the gate.
    """
    allowed: List[str] = []
    for full in (jid, lid):
        if not full:
            continue
        allowed.append(full)
        user = str(full).split("@")[0].split(":")[0]
        for suffix in ("@s.whatsapp.net", "@lid"):
            candidate = f"{user}{suffix}"
            if candidate not in allowed:
                allowed.append(candidate)
    return allowed


@router.post("/whatsapp/onboarding/{pairing_id}/apply", response_model=Dict[str, Any])
def apply_whatsapp_onboarding(pairing_id: str, body: Optional[TelegramOnboardingApply] = None) -> Dict[str, Any]:
    with _whatsapp_pairings_lock:
        record = _whatsapp_pairings.get(pairing_id)
        if not record or not record.get("jid"):
            raise HTTPException(
                status_code=400,
                detail={"code": "pairing_not_ready", "message": "La sessione WhatsApp non è ancora collegata."},
            )
        jid = record["jid"]
        lid = record.get("lid")
        _whatsapp_pairings.pop(pairing_id, None)

    saved = _load_channels_config()
    current = saved.get("whatsapp") or {"enabled": False, "fields": {}}
    fields = dict(current.get("fields") or {})
    # Default authorization: both identities of the paired account itself, so
    # "message yourself" works out of the box; extra senders go in the UI field.
    allowed = body.allowed_user_ids if body and body.allowed_user_ids else _whatsapp_allowed_ids(jid, lid)
    if allowed:
        fields["allowed_user_ids"] = ", ".join(str(u).strip() for u in allowed if str(u).strip())
    current["enabled"] = True
    current["fields"] = fields
    saved["whatsapp"] = current
    _save_channels_config(saved)
    _apply_channel_to_adapter("whatsapp", current)
    return {"ok": True, "platform": "whatsapp", "jid": jid, "enabled": True, "fields": fields}


@router.delete("/whatsapp/onboarding/{pairing_id}", response_model=Dict[str, Any])
def cancel_whatsapp_onboarding(pairing_id: str) -> Dict[str, Any]:
    with _whatsapp_pairings_lock:
        _whatsapp_pairings.pop(pairing_id, None)
    return {"ok": True}


@router.post("/{platform}/inbound", response_model=Dict[str, Any])
async def ingest_channel_inbound(
    platform: str,
    request: Request,
) -> Dict[str, Any]:
    """Ingress webhook for messaging platforms: persists to queue, checks pairing, leases turn, and delivers response."""
    try:
        raw_payload = await request.json()
    except Exception:
        raw_payload = {}

    registry = get_channel_registry()
    adapter = registry.get_adapter(platform)
    if not adapter:
        raise HTTPException(
            status_code=404,
            detail={"code": "channel_platform_unsupported", "message": f"Platform '{platform}' is not supported."},
        )

    # Ingress webhook: persists to queue, checks pairing, leases turn, and
    # bridges the message into a supervised engine conversation.
    try:
        result = registry.dispatch_inbound(platform, raw_payload, channel_reply)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "inbound_error", "message": str(exc)})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"code": "inbound_failed", "message": str(exc)})


@router.get("/queue", response_model=Dict[str, Any])
def list_inbound_queue_items(
    platform: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    queue = get_inbound_channel_queue()
    items = queue.list_items(platform=platform, status=status, limit=limit)
    return {
        "count": len(items),
        "items": [it.to_dict() for it in items],
    }


@router.post("/queue/recover", response_model=RecoverQueueResponse)
def recover_stale_inbound_queue(
    max_age_seconds: float = Query(60.0, ge=1.0),
) -> RecoverQueueResponse:
    queue = get_inbound_channel_queue()
    recovered = queue.recover_stale_claims(max_age_seconds=max_age_seconds)
    return RecoverQueueResponse(recovered_count=recovered)


@router.post("/{platform}/poll-once", response_model=Dict[str, Any])
def poll_channel_once(
    platform: str,
    timeout: int = Query(5, ge=1, le=30),
) -> Dict[str, Any]:
    """Execute a single polling iteration for polling-capable channels (e.g. Telegram getUpdates)."""
    plat = platform.strip().lower()
    registry = get_channel_registry()
    adapter = registry.get_adapter(plat)
    if not adapter:
        raise HTTPException(status_code=404, detail={"code": "channel_platform_unsupported", "message": f"Platform '{platform}' is not supported."})

    token = getattr(adapter, "config", {}).get("bot_token") or getattr(adapter, "config", {}).get("TELEGRAM_BOT_TOKEN")
    if not token and plat == "telegram":
        raise HTTPException(status_code=400, detail={"code": "credentials_missing", "message": f"No bot token configured for {plat} polling."})

    queue = get_inbound_channel_queue()

    def _ingest_update(upd: Dict[str, Any]) -> None:
        try:
            registry.dispatch_inbound(plat, upd, channel_reply)
        except Exception:
            try:
                msg = adapter.parse_inbound(upd)
                queue.enqueue(plat, upd, msg)
            except Exception:
                pass

    poller = ChannelPoller(plat, token or "", _ingest_update)
    updates = poller.poll_once(timeout=timeout)
    return {
        "platform": plat,
        "polled_count": len(updates),
        "updates": updates,
    }


def poll_enabled_channels(timeout: int = 1) -> None:
    saved = _load_channels_config()
    for plat in ("telegram",):
        cfg = saved.get(plat) or {}
        if not cfg.get("enabled"):
            continue
        fields = cfg.get("fields") or {}
        token = fields.get("bot_token") or os.environ.get(f"{plat.upper()}_BOT_TOKEN")
        if not token:
            continue
        try:
            poll_channel_once(plat, timeout=timeout)
        except Exception:
            pass
