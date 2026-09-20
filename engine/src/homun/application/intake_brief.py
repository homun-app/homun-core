"""Versioned brief updates: the engine, not the model, preserves unmodified fields.

A refinement proposal declares which brief fields the person changed
(`changed_fields`). Every other field is carried over verbatim from the anchor
brief (the latest proposal with a non-empty objective), so a staffing-only
clarification can never rewrite objective, output, constraints or capability —
even when the model returns different text for them.
"""
from homun.models.intake import IntakeBrief

PRESERVED_FIELDS = ('title', 'objective', 'output', 'constraints', 'capability')


def staffing_label(brief: dict) -> str | None:
    if brief.get('suggested_agent'):
        return brief['suggested_agent']['name']
    if brief.get('new_agent'):
        return brief['new_agent']['name']
    return None


def stabilize(brief: IntakeBrief, anchor: dict) -> dict:
    """Values for persistence: undeclared fields keep the anchor's content."""
    values = brief.model_dump(exclude={'suggested_agent_id'})
    declared = set(brief.changed_fields)
    for field in PRESERVED_FIELDS:
        if field not in declared:
            values[field] = anchor[field]
    return values


def preserve_staffing(values: dict, anchor: dict, catalog: list[dict]) -> dict:
    """Keep the anchor's collaborator when a CSV refinement proposes none.

    The staffing suggestion is normally fresh, but a carried-over compare_csv
    brief without any collaborator could never be confirmed; preserving the
    standing agreement's staffing keeps the proposal actionable. Existing
    agents are re-resolved against the current catalog so revisions stay valid.
    """
    if values.get('capability') != 'compare_csv':
        return values
    if values.get('suggested_agent') or values.get('new_agent'):
        return values
    if anchor.get('suggested_agent'):
        current = next((a for a in catalog if a['id'] == anchor['suggested_agent']['id']), None)
        if current:
            values['suggested_agent'] = {k: current[k] for k in ('id', 'name', 'role', 'revision')}
            return values
    if anchor.get('new_agent'):
        values['new_agent'] = anchor['new_agent']
    return values


def brief_changes(anchor: dict | None, values: dict) -> list[dict]:
    """Backend-computed diff against the anchor brief; empty on first proposal."""
    if anchor is None:
        return []
    changes = []
    for field in PRESERVED_FIELDS:
        if values.get(field) != anchor.get(field):
            changes.append({'field': field, 'from_value': anchor.get(field), 'to_value': values.get(field)})
    anchor_staffing = staffing_label(anchor)
    next_staffing = staffing_label(values)
    if anchor_staffing != next_staffing:
        changes.append({'field': 'staffing', 'from_value': anchor_staffing, 'to_value': next_staffing})
    return changes
