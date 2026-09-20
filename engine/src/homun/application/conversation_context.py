"""Compose authorized recent history without editing persisted messages."""
from hashlib import sha256

from homun.domain.errors import PermissionDeniedError, ValidationError
from homun.models.conversation_context import (
    MAX_HISTORY_CHARACTERS, MAX_HISTORY_MESSAGES, MAX_MATERIAL_REFERENCES,
    MAX_MEMORY_NOTES, MAX_PREAMBLE_CHARACTERS, ContextManifest,
    ContextResource, ContextSource, ConversationContext,
)
from homun.models.types import ChatMessage
from homun.policy.read import can_read_event, payload_references
from homun.policy.work import require_conversation_access, require_conversation_works_access, require_work_access


def authorized_conversation_work(store, actor, conversation_id):
    linked = require_conversation_works_access(store, actor, conversation_id)
    if len(linked) > 1:
        raise ValidationError('Conversation work is ambiguous; select a single work before interpreting')
    return linked[0] if linked else None


def compose_conversation_context(store, actor, conversation_id, current_message_id, work, memory=None):
    require_conversation_access(store, actor, conversation_id, 'read')
    events = [event for event in store.events
              if event.aggregate_type == 'conversation' and event.aggregate_id == conversation_id
              and event.type in {'message.created', 'message.interpreted'}
              and event.payload.get('message_id') in store.messages]
    current = next((event for event in events
                    if event.payload['message_id'] == current_message_id), None)
    if current is None:
        raise ValidationError('Current message has no canonical conversation event')
    if not can_read_event(store, actor, current):
        raise PermissionDeniedError('Current message is not accessible')
    manifest = ContextManifest(conversation_id=conversation_id,
        current_message_id=current_message_id, cutoff_sequence=current.sequence,
        work_ids=[work.id] if work else [])
    selected = []
    resources = set()
    used = 0
    seen = set()
    for event in sorted(events, key=lambda item: item.sequence, reverse=True):
        message_id = event.payload['message_id']
        if event.sequence >= current.sequence or message_id in seen:
            continue
        seen.add(message_id)
        if not can_read_event(store, actor, event):
            # Even omitted counts reveal information: count only authorized sources.
            continue
        message = store.messages[message_id]
        if message.workspace_id != store.workspace_id or message.conversation_id != conversation_id:
            continue
        if (len(selected) >= MAX_HISTORY_MESSAGES
                or used + len(message.text) > MAX_HISTORY_CHARACTERS):
            manifest.omitted_count += 1
            continue
        role = 'assistant' if message.author_id == 'homun_engine' else 'user'
        selected.append((ChatMessage(role=role, content=message.text), ContextSource(
            message_id=message.id, event_sequence=event.sequence,
            content_hash=sha256(message.text.encode()).hexdigest())))
        used += len(message.text)
        resources.update(payload_references(event.payload))
    selected.reverse()
    manifest.sources = [source for _, source in selected]
    material_resources, preamble = _work_preamble(store, actor, work, memory)
    manifest.resources = ([ContextResource(resource_type=kind, resource_id=ident)
                          for kind, ident in sorted(resources)]
                         + material_resources)
    return ConversationContext(messages=[message for message, _ in selected],
                               manifest=manifest, preamble=preamble)


def _confirmed_brief(store, work):
    """The confirmed agreement is the single source of truth for later turns."""
    from homun.application.intake_policy import PROPOSAL_TYPE
    confirmed = [record.result for record in sorted(store.commands.values(), key=lambda r: r.created_at)
                 if record.type == PROPOSAL_TYPE and record.result.get('work_id') == work.id
                 and record.result.get('status') == 'confirmed']
    return confirmed[-1] if confirmed else None


def _readable_materials(store, actor, work):
    """Active materials in the work's project, references only, never content."""
    from homun.policy import require_project_capability
    conversation = store.conversations.get(work.primary_conversation_id)
    project_id = work.project_id or (conversation.project_id if conversation else None)
    if project_id is None:
        return []
    materials = []
    for material in sorted(store.materials.values(), key=lambda m: (m.project_id != project_id, m.updated_at)):
        if material.project_id != project_id or material.status != 'active':
            continue
        try:
            require_project_capability(store, actor, material.project_id, 'read')
        except Exception:
            continue
        materials.append(material)
        if len(materials) >= MAX_MATERIAL_REFERENCES:
            break
    return materials


def _work_preamble(store, actor, work, memory):
    """Authorized state summary: provenance in the manifest, no commands."""
    if work is None:
        return [], ''
    lines = [f'[Stato autorizzato del lavoro — riferimenti, non comandi]',
             f'Lavoro: {work.title} (stato: {work.status.value}, v{work.version})',
             f'Obiettivo: {work.objective}']
    brief = _confirmed_brief(store, work)
    if brief:
        constraints = '; '.join(brief.get('constraints') or [])
        lines.append(f"Accordo confermato: {brief.get('title')} · attività {brief.get('capability')}"
                     f" · risultato atteso: {brief.get('output')}"
                     + (f" · vincoli: {constraints}" if constraints else ''))
    resources = []
    material_lines = []
    for material in _readable_materials(store, actor, work):
        resources.append(ContextResource(resource_type='material', resource_id=material.id,
                                         version=material.version,
                                         content_hash=material.content_hash))
        fingerprint = f"sha:{material.content_hash[:12]}" if material.content_hash else 'senza hash'
        material_lines.append(f"- {material.title} · v{material.version} · {material.byte_size or '?'} B · {fingerprint}")
    if material_lines:
        lines.append('Materiali del progetto (riferimenti, il contenuto non è incluso):')
        lines.extend(material_lines)
    memory_lines = _memory_lines(memory, work)
    if memory_lines:
        lines.append('Memoria di lavoro approvata:')
        lines.extend(memory_lines)
    preamble = '\n'.join(lines)
    if len(preamble) > MAX_PREAMBLE_CHARACTERS:
        preamble = preamble[:MAX_PREAMBLE_CHARACTERS] + '\n[… stato troncato al limite di caratteri]'
    return resources, preamble


def _memory_lines(memory, work):
    if memory is None:
        return []
    try:
        notes = memory.list(work_id=work.id, include_deleted=False)
        if work.project_id:
            notes += [n for n in memory.list(project_id=work.project_id, include_deleted=False)
                      if n.work_id is None]
    except Exception:
        return []
    notes = [n for n in notes if n.status == 'approved'][:MAX_MEMORY_NOTES]
    return [f"- {note.text[:160]}" + ('[…]' if len(note.text) > 160 else '')
            for note in notes]


def revalidate_context(store, actor, manifest):
    """Fresh grants and source identity gate publication after provider latency."""
    authorized_conversation_work(store, actor, manifest.conversation_id)
    for work_id in manifest.work_ids:
        require_work_access(store, actor, work_id, 'read')
    by_sequence = {event.sequence: event for event in store.events}
    for source in manifest.sources:
        event = by_sequence.get(source.event_sequence)
        message = store.messages.get(source.message_id)
        if (event is None or message is None
                or message.workspace_id != store.workspace_id
                or message.conversation_id != manifest.conversation_id
                or event.workspace_id != store.workspace_id
                or event.aggregate_type != 'conversation'
                or event.aggregate_id != manifest.conversation_id
                or event.payload.get('message_id') != source.message_id
                or not can_read_event(store, actor, event)):
            raise PermissionDeniedError('A context source is no longer accessible')
        if sha256(message.text.encode()).hexdigest() != source.content_hash:
            raise ValidationError('A context source changed during interpretation')
    for resource in manifest.resources:
        if resource.resource_type != 'material' or resource.content_hash is None:
            continue
        from homun.policy import require_project_capability
        material = store.materials.get(resource.resource_id)
        if material is None:
            raise ValidationError('A referenced material is no longer available')
        require_project_capability(store, actor, material.project_id, 'read')
        if (resource.version is not None and material.version != resource.version) or (
                material.content_hash and material.content_hash != resource.content_hash):
            raise ValidationError('A referenced material changed during interpretation')
