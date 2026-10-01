"""Truncate-and-store per le pagine web: il modello vede una finestra, il resto si sfoglia.

Porta del pipeline di hermes-agent (MIT, Copyright Nous Research), adattato a
Homun: le pagine oltre il budget diventano una finestra ~75% testa / ~25% coda
(tagliata su confini di riga) con un footer che dichiara quanto è mostrato,
dove sta il testo completo (cache del workspace) e la chiamata
``list_workspace_files``/lettura per sfogliare la parte omessa. Il testo
completo va su disco, mai perso.
"""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Budget per pagina verso il modello (config: web.extract_char_limit).
DEFAULT_EXTRACT_CHAR_LIMIT = 15000
CHAR_LIMIT_FLOOR, CHAR_LIMIT_CEILING = 2000, 500_000
# Tetto del testo archiviato: il modello vede sempre il budget, il disco nemmeno
# troppo (una pagina multi-MB non deve scrivere byte illimitati a ogni estrazione).
MAX_STORED_TEXT_CHARS = 2_000_000


def clamp_char_limit(value) -> int:
    return max(CHAR_LIMIT_FLOOR, min(int(value), CHAR_LIMIT_CEILING))


def _host_slug(url: str) -> str:
    host = re.sub(r"[^a-z0-9.-]", "", url.split("//", 1)[-1].split("/", 1)[0].lower())
    return (host or "page")[:60]


def store_full_text(cache_dir: Path, url: str, content: str) -> Optional[Path]:
    """Scrive la pagina completa in cache; None se il filesystem rifiuta."""
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:10]
        path = cache_dir / f"{_host_slug(url)}-{digest}.md"
        if len(content) > MAX_STORED_TEXT_CHARS:
            content = content[:MAX_STORED_TEXT_CHARS] + (
                f"\n\n[... copia archiviata troncata a {MAX_STORED_TEXT_CHARS:,} caratteri "
                f"su {len(content):,}; re-estraisci un URL più specifico per il resto ...]"
            )
        path.write_text(content, encoding="utf-8")
        return path
    except Exception:
        logger.warning("archiviazione pagina completa fallita per %s", url, exc_info=True)
        return None


def truncate_with_footer(content: str, url: str, char_limit: int,
                         stored_path: Optional[Path] = None) -> Tuple[str, bool]:
    """(testo_per_il_modello, troncata). Finestra testa/coda + footer che istruisce
    l'agente su come sfogliare il resto. Deterministica."""
    if len(content) <= char_limit:
        return content, False
    head_budget = int(char_limit * 0.75)
    tail_budget = char_limit - head_budget
    head, tail = content[:head_budget], content[-tail_budget:]
    # tagli su confini di riga: mai metà riga
    if (nl := head.rfind("\n")) > head_budget * 0.5:
        head = head[:nl]
    if 0 <= (nl := tail.find("\n")) < tail_budget * 0.5:
        tail = tail[nl + 1:]

    footer_lines = [
        "", "─" * 8 + " [TRONCATA] " + "─" * 8,
        f"Mostrati {len(head):,} caratteri (testa) + {len(tail):,} (coda) "
        f"su {len(content):,} totali.",
    ]
    if stored_path is not None:
        footer_lines += [
            f"Testo completo salvato nel workspace: {stored_path.name}",
            "Per leggere la parte omessa usa list_workspace_files e leggi il file "
            "dalla cache web del workspace.",
        ]
    else:
        footer_lines.append(
            "Testo completo non archiviato: re-estrai un URL più specifico "
            "o usa il browser per la pagina intera."
        )
    footer_lines.append("─" * 29)
    model_text = head + "\n\n[... parte centrale omessa — vedi footer ...]\n\n" + tail
    return model_text + "\n" + "\n".join(footer_lines), True
