"""La diagnosi del recovery raccontata in chat dal modello, ad alta voce.

Il ripristino del database è deterministico (storage.recovery); qui il rapporto
diventa una conversazione: un messaggio deterministico con i numeri precisi è
sempre garantito, poi un turno della chat chiede al modello di spiegarlo —
con lo streaming del ragionamento già visibile nel thread.
"""
from __future__ import annotations

import logging
from typing import Any

from homun.domain.models import Actor, utc_now

logger = logging.getLogger(__name__)

RECOVERY_CONVERSATION_TITLE = "Diagnosi motore"


def _report_text(report: dict[str, Any]) -> str:
    lines = [
        "🛠️ **Ripristino database completato** — il motore si è avviato in modalità recupero.",
        "",
        f"- Modalità: **{report.get('mode')}**"
        " (repaired = ricostruito dal salvabile, minimal = workspace nuovo)",
        f"- Originali in quarantena: `{report.get('quarantine_dir')}`",
    ]
    tables = report.get("tables") or {}
    if tables:
        lines.append("- Righe recuperate per tabella:")
        for table, stats in sorted(tables.items()):
            lines.append(f"  - `{table}`: {stats.get('kept', 0)} conservate, {stats.get('lost', 0)} perse")
    issues = report.get("issues") or []
    if issues:
        lines.append(f"- Problemi rilevati: **{len(issues)}**")
        for issue in issues[:8]:
            lines.append(f"  - {issue.get('kind')} su {issue.get('table')}: {issue.get('detail')}")
        if len(issues) > 8:
            lines.append(f"  - … e altri {len(issues) - 8}")
    lines += [
        "",
        "I file originali corrotti sono al sicuro in quarantena: nulla è stato cancellato.",
    ]
    return "\n".join(lines)


def _apply(ctx, actor: Actor, command_id: str, kind: str, payload: dict) -> dict:
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _find_or_create_conversation(ctx, actor: Actor) -> str:
    store = ctx.repository.snapshot()
    for conversation in store.conversations.values():
        if conversation.title == RECOVERY_CONVERSATION_TITLE and not conversation.archived:
            return conversation.id
    from homun.domain.ids import new_id
    result = _apply(ctx, actor, f"conv:{new_id('cmd')}", 'conversation.create',
                    {'title': RECOVERY_CONVERSATION_TITLE})
    return result['conversation_id']


def seed_recovery_conversation(ctx, report: dict[str, Any]) -> str | None:
    """Conversazione con il rapporto + turno del modello che lo spiega.

    Il messaggio deterministico con i numeri è sempre garantito; il turno
    chiede al modello di spiegarlo ragionando (streaming del ragionamento
    incluso). I numeri viaggiano anche nel prompt: il modello non dipende
    dal binding della storia.
    """
    from homun.domain.ids import new_id

    actor = Actor(id='homun_engine', workspace_id=ctx.workspace_id,
                  display_name='Homun', kind='agent')
    prompt = (
        "All'avvio il database del workspace era corrotto e il motore lo ha "
        "ricostruito in automatico. Spiega in italiano, in modo semplice e "
        "concreto, cosa è successo, cosa è stato recuperato, cosa è andato "
        "perso e cosa posso fare ora (quarantena, backup, restore). "
        "Non inventare numeri: usa solo questi del rapporto.\n\n"
        + _report_text(report)
    )
    try:
        conversation_id = _find_or_create_conversation(ctx, actor)
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                ctx.service.for_store(store).append_engine_message(
                    actor=actor,
                    command_id=f"diag:{new_id('cmd')}",
                    conversation_id=conversation_id,
                    author_id='homun_engine',
                    text=_report_text(report),
                )
                ctx.service.for_store(store).append_engine_message(
                    actor=actor,
                    command_id=f"diagq:{new_id('cmd')}",
                    conversation_id=conversation_id,
                    author_id='person_fabio',
                    text="Spiega cos'è successo al database usando il rapporto qui sopra.",
                )
            ctx.service.store = store
    except Exception:
        logger.exception("Impossibile scrivere il rapporto di recovery in chat")
        return None

    try:
        from homun.application.chat_agent import start_chat_turn
        requester = Actor(id='person_fabio', workspace_id=ctx.workspace_id,
                          display_name='Fabio', kind='person')
        start_chat_turn(ctx, requester, conversation_id, prompt)
    except Exception:
        logger.warning("Turno di diagnosi non avviato (modelli non pronti?)",
                       exc_info=True)
    return conversation_id
