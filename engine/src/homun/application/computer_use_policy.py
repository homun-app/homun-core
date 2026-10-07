"""Computer-use authority tiers: hard-block, sensitive (always human), allowlist.

Three tiers, checked in order before any driver call:

1. ``blocked``    — destructive system input (key combos, dangerous typed
                    text). Refused for everyone, no override, mirroring the
                    Hermes hard-block list.
2. ``sensitive``  — money movement surface (banking/payment apps, checkout
                    and transfer patterns). Always a human gate: never
                    auto-approved, never allowlisted.
3. ``allowlisted``/``needs_approval`` — the app is (or is not) in the
                    agent's per-app allowlist; autonomous agents may act on
                    allowlisted apps, everything else gates on a person.

The classifier is deliberately heuristic and fails safe: an unknown app or
an ambiguous action resolves to ``needs_approval``/``sensitive``, never to
``allowlisted``.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

# Mirrors of the Hermes hard-blocks (tools/computer_use/tool.py): destructive
# system shortcuts and dangerous shell patterns typed through the keyboard.
BLOCKED_KEY_COMBOS = {
    frozenset({"cmd", "shift", "backspace"}), frozenset({"cmd", "option", "backspace"}),
    frozenset({"cmd", "ctrl", "q"}), frozenset({"cmd", "shift", "q"}),
    frozenset({"cmd", "option", "shift", "q"}), frozenset({"win", "l"}),
    frozenset({"ctrl", "option", "delete"}), frozenset({"ctrl", "option", "del"}),
    frozenset({"option", "f4"}),
}
BLOCKED_TYPE_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"curl\s+[^|]*\|\s*bash", r"curl\s+[^|]*\|\s*sh", r"wget\s+[^|]*\|\s*bash",
    r"\bsudo\s+rm\s+-[rf]", r"\brm\s+-rf\s+/\s*$", r":\s*\(\)\s*\{\s*:\|:\s*&\s*\}",
))
_KEY_ALIASES = {"command": "cmd", "control": "ctrl", "alt": "option", "⌘": "cmd",
                "⌥": "option", "windows": "win", "super": "win", "meta": "win"}

# Money-movement surfaces: app identities and action contexts. Italian and
# English. Anything matching here is a human decision, always.
SENSITIVE_APP_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\bbank|banca|banco\b", r"paypal", r"\bwise\b", r"revolut", r"satispay",
    r"poste\b", r"\bbposte\b", r"\bhype\b", r"\billimity\b", r"\bflowe\b",
    r"\bn26\b", r"\bing\b( ?direct)?", r"mediolanum", r"\bfineco\b", r"\bsella\b",
    r"\bcripto|crypto|binance|coinbase|kraken\b", r"\bsatispay\b", r"stripe",
    r"checkout", r"payment|pagament", r"bonific", r"home ?banking", r"trading",
    r"\betrade\b|e-trade|interactive ?brokers|\bit\b(?=.*trad)", r"money ?transfer",
    r"\bwhatsapp pay\b|\bzelle\b|\bvenmo\b|\bcash ?app\b",
))
SENSITIVE_TEXT_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"paga(?:re)?\b|payment|checkout|cart", r"bonific|transfer|wire",
    r"\bIBAN\b|\bcarta\b(?:\s+di)?\s*credito|card ?number|CVV|CVC",
    r"conferma(?:re)?\s+(?:l[oa])?\s*(?:ordine|acquisto|pagamento)",
    r"buy\s+now|procedi\s+al\s+pagamento",
))

ALLOWED_ACTIONS = frozenset({
    "capture", "click", "double_click", "right_click", "type", "key",
    "scroll", "move", "wait", "screenshot", "launch", "focus", "quit",
})


def _canon_key_combo(keys: str) -> frozenset:
    parts = re.split(r"\s*[+\-]\s*", (keys or "").strip().lower())
    return frozenset(_KEY_ALIASES.get(p, p) for p in parts if p)


def classify(action: Dict[str, Any], *, app: Optional[str] = None,
             allowlist: Optional[list[str]] = None) -> Dict[str, Any]:
    """Resolve the authority tier for one computer-use action.

    Returns ``{"tier": ..., "reason": ...}`` where tier is one of
    ``blocked | sensitive | allowlisted | needs_approval``.
    """
    name = str(action.get("action") or "").strip().lower()
    if name not in ALLOWED_ACTIONS:
        return {"tier": "blocked", "reason": f"unknown action: {name}"}

    if name == "key":
        combo = _canon_key_combo(str(action.get("keys") or ""))
        for blocked in BLOCKED_KEY_COMBOS:
            if blocked and blocked.issubset(combo):
                return {"tier": "blocked",
                        "reason": f"destructive key combo: {sorted(blocked)}"}
    if name == "type":
        text = str(action.get("text") or "")
        for pattern in BLOCKED_TYPE_PATTERNS:
            if pattern.search(text):
                return {"tier": "blocked",
                        "reason": f"dangerous typed pattern: {pattern.pattern!r}"}

    # Sensitive surfaces: app identity first, then the action's own context
    # (typed text, the element being clicked).
    surface = " ".join(filter(None, [
        app or "", str(action.get("app") or ""),
        str(action.get("text") or ""), str(action.get("element") or ""),
        str(action.get("label") or ""),
    ]))
    for pattern in SENSITIVE_APP_PATTERNS:
        if pattern.search(surface):
            return {"tier": "sensitive", "reason": f"money surface: {pattern.pattern!r}"}
    for pattern in SENSITIVE_TEXT_PATTERNS:
        if pattern.search(surface):
            return {"tier": "sensitive", "reason": f"money action: {pattern.pattern!r}"}

    if allowlist and app and str(app).strip().casefold() in {
            str(a).strip().casefold() for a in allowlist}:
        return {"tier": "allowlisted", "reason": f"app in allowlist: {app}"}
    return {"tier": "needs_approval",
            "reason": f"app not in allowlist: {app or '(sconosciuta)'}"}


def gate_required(verdict: Dict[str, Any], *, autonomous: bool) -> bool:
    """Does this action still need a human gate before execution?

    The allowlist is the fence of *autonomy*, not a supervision bypass:
    allowlisted apps gate for supervised agents too, unlisted apps and
    sensitive surfaces gate for everyone.
    """
    tier = verdict.get("tier")
    if tier == "blocked":
        raise ValueError("blocked actions are refused, never gated")
    if tier in {"sensitive", "needs_approval"}:
        return True
    return not autonomous
