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


def _standing_agent(anchor: dict, catalog: list[dict], owner_id: str | None) -> dict | None:
    """Resolve the standing collaborator of an agreement against the roster.

    The anchor's suggested agent wins; a confirmed new_agent is found by name
    (it exists in the roster since its confirmation); the work's confirmed
    owner covers anchors whose staffing was stripped by older revisions.
    """
    suggested = anchor.get('suggested_agent')
    if suggested:
        current = next((a for a in catalog if a['id'] == suggested['id']), None)
        if current:
            return current
    if anchor.get('new_agent'):
        name = (anchor['new_agent'].get('name') or '').strip().casefold()
        current = next((a for a in catalog if a['name'].strip().casefold() == name), None)
        if current:
            return current
    if owner_id:
        return next((a for a in catalog if a['id'] == owner_id), None)
    return None


def preserve_staffing(values: dict, anchor: dict, catalog: list[dict], owner_id: str | None = None) -> dict:
    """Keep the standing collaborator unless the person explicitly swaps them.

    The engine, not the model, protects agreement continuity: a refinement that
    does not declare `staffing` in changed_fields cannot swap the responsible
    collaborator, so a fresh suggestion (or an invented twin profile) gives way
    to the standing one. An emptied suggestion also keeps the standing staffing
    so the brief stays confirmable — for every capability, not just compare_csv.
    Existing agents are re-resolved against the current catalog so revisions
    stay valid.
    """
    standing = _standing_agent(anchor, catalog, owner_id)
    declared = set(values.get('changed_fields') or [])
    if values.get('suggested_agent') or values.get('new_agent'):
        fresh_new = values.get('new_agent')
        # A declared staffing change wins only when it is a real swap: a new
        # profile repeating the standing collaborator's name is the same person
        # re-proposed, and confirming it would duplicate the roster entry.
        same_standing = (
            isinstance(fresh_new, dict)
            and standing is not None
            and str(fresh_new.get('name') or '').strip().casefold()
            == str(standing.get('name') or '').strip().casefold()
        )
        if standing is None or ('staffing' in declared and not same_standing):
            return values
        values['suggested_agent'] = {k: standing[k] for k in ('id', 'name', 'role', 'revision')}
        values['new_agent'] = None
        return values
    if standing is not None:
        values['suggested_agent'] = {k: standing[k] for k in ('id', 'name', 'role', 'revision')}
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
