"""Durable transcript projection from canonical, currently authorized events."""
from itertools import islice

from homun.policy.read import visible_event
from homun.policy.work import require_conversation_works_access


_MESSAGE_EVENTS = {'message.created', 'message.interpreted'}
_CARD_FIELDS = ('interpretation', 'patch_proposal', 'plan_draft')


def conversation_message_page(store, actor, conversation_id, after, limit):
    require_conversation_works_access(store, actor, conversation_id)
    seen = set()

    def candidates():
        for event in sorted(store.events, key=lambda item: item.sequence):
            if (event.aggregate_type != 'conversation'
                    or event.aggregate_id != conversation_id
                    or event.type not in _MESSAGE_EVENTS):
                continue
            message_id = event.payload.get('message_id')
            is_first = isinstance(message_id, str) and message_id not in seen
            # The first canonical event owns provenance, even when denied. A
            # later duplicate must never make an inaccessible message visible.
            if isinstance(message_id, str):
                seen.add(message_id)
            if event.sequence > after:
                yield event, is_first

    scanned = list(islice(candidates(), limit + 1))
    has_more = len(scanned) > limit
    scanned = scanned[:limit]
    items = []
    for event, is_first in scanned:
        if not is_first:
            continue
        view = visible_event(store, actor, event)
        if view is None:
            continue
        message = store.messages.get(event.payload['message_id'])
        if (message is None or message.workspace_id != store.workspace_id
                or message.conversation_id != conversation_id):
            continue
        item = message.model_dump(mode='json', exclude={'workspace_id'})
        item['sequence'] = event.sequence
        for field in _CARD_FIELDS:
            value = view['payload'].get(field)
            if isinstance(value, dict):
                item[field] = value
        items.append(item)
    return {'items': items, 'cursor': scanned[-1][0].sequence if scanned else after,
            'has_more': has_more}
