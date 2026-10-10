"""Minimal public follow-up notices, excluding persisted request/actor context."""


def conversation_followups(store, conversation_id, actor):
    notices = []
    for record in store.commands.values():
        if record.type != 'conversation.post_message' or record.followup_status not in {'processing', 'failed'}:
            continue
        # Message linkage also works for legacy claims without recovery context.
        message = store.messages.get(record.result.get('message_id'))
        if message is None or message.conversation_id != conversation_id:
            continue
        conversation = store.conversations[conversation_id]
        if not conversation.project_id and record.actor_id != actor.id:
            continue
        status = record.followup_status
        if status == 'failed' and record.followup_next_attempt_at is not None:
            status = 'retry_scheduled'
        notices.append({'command_id': record.command_id, 'status': status,
                        'error_code': record.followup_error, 'attempts': record.followup_attempts})
    return notices
