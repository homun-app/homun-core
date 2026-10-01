"""Iniezione di memoria e skill nel system prompt — porta hermes-agent.

Fonte: agent/system_prompt.py (_memory_parts, _skills_prompt),
agent/prompt_builder.py (build_skills_system_prompt, blocco ## Skills),
tools/memory_tool_store.py (_render_block, MEMORY_BLOCK_HEADERS).
Adattamento dichiarato: le memorie Homun sono scoped dal MemoryPort
(person/project) invece del file MEMORY.md; l'indice skill legge lo store
del workspace invece della directory skill di Hermes.
"""
from __future__ import annotations

from typing import Optional

# memory_tool_store.py:20-23 — intestazioni e delimitatore identici
MEMORY_BLOCK_HEADERS = {
    "memory": "MEMORY (your personal notes)", "user": "USER PROFILE (who the user is)"}
ENTRY_DELIMITER = "\n§\n"
_MEMORY_BUDGET = 4000


def memory_block(notes: list[str], target: str = "memory") -> str:
    """Il blocco memoria nel formato Hermes: header + usage + voci, vuoto se non c'è niente."""
    entries = [str(note).strip() for note in notes if str(note).strip()]
    if not entries:
        return ""
    content = ENTRY_DELIMITER.join(entries)
    # budget a caratteri come usage indicator di Hermes (percentuale sul tetto)
    usage = f"{len(content)} chars"
    sep = "═" * 46
    title = MEMORY_BLOCK_HEADERS["user" if target == "user" else "memory"]
    return f"{sep}\n{title} [{usage}]\n{sep}\n{content}"


def skills_block(skills: list[dict]) -> str:
    """Il blocco ## Skills di Hermes: scan-obbligo + indice nome: descrizione.

    skills: [{name, description}] dallo store del workspace.
    """
    index_lines = [f"- {entry.get('name', '?')}: {str(entry.get('description', ''))[:100]}"
                   for entry in skills if entry.get("name")]
    if not index_lines:
        return ""
    return (
        "## Skills\n"
        "Before replying, scan the skills below. If a skill matches or is even partially relevant to your "
        "task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of "
        "loading — it is always better to have context you don't need than to miss critical steps, pitfalls, "
        "or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific "
        "commands, and proven workflows that outperform general-purpose approaches.\n"
        "If a skill has issues, fix it with skill_patch.\n"
        "After difficult/iterative tasks, offer to save as a skill.\n"
        "\n"
        "<available_skills>\n"
        + "\n".join(index_lines[:80]) + "\n"
        "</available_skills>\n\n"
        "Only proceed without loading a skill if genuinely none are relevant to the task."
    )


def volatile_parts(memory_notes: list[str], user_notes: list[str],
                    skills: list[dict]) -> str:
    """La parte volatile del prompt Hermes: memoria + profilo + indice skill."""
    parts = []
    block = memory_block(memory_notes, "memory")
    if block:
        parts.append(block)
    block = memory_block(user_notes, "user")
    if block:
        parts.append(block)
    block = skills_block(skills)
    if block:
        parts.append(block)
    return "\n\n".join(parts)
