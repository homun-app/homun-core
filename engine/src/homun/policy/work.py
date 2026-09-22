"""Current project authority for conversation/work commands and deferred effects."""
from homun.domain.errors import NotFoundError
from homun.policy import require_project_capability, require_workspace_actor


def require_conversation_access(store, actor, conversation_id, needed='write'):
    require_workspace_actor(actor, store.workspace_id)
    conversation = store.conversations.get(str(conversation_id))
    if conversation is None:
        raise NotFoundError('Conversation not found')
    if conversation.project_id:
        require_project_capability(store, actor, conversation.project_id, needed)
    return conversation


def require_conversation_works_access(store, actor, conversation_id):
    """Authorize a conversation and every linked work without imposing cardinality."""
    require_conversation_access(store, actor, conversation_id, 'read')
    linked = [work for work in store.works.values()
              if conversation_id in work.conversation_ids
              or work.primary_conversation_id == conversation_id]
    for work in linked:
        require_work_access(store, actor, work.id, 'read')
    return linked


def require_work_access(store, actor, work_id, needed='write'):
    require_workspace_actor(actor, store.workspace_id)
    work = store.works.get(str(work_id))
    if work is None:
        raise NotFoundError('Work not found')
    for project_id in sorted(work_project_ids(store, work)):
        require_project_capability(store, actor, project_id, needed)
    return work


def work_project_ids(store, work):
    projects = {work.project_id} if work.project_id else set()
    for conversation_id in {*work.conversation_ids, work.primary_conversation_id}:
        conversation = store.conversations.get(conversation_id)
        if conversation and conversation.project_id:
            projects.add(conversation.project_id)
    return projects


def require_work_command_authority(store, actor, command_type, payload):
    """Called before command execution and replay; never grant access implicitly."""
    if command_type == 'conversation.create':
        if payload.get('project_id') is not None:
            require_project_capability(store, actor, str(payload['project_id']), 'write')
    elif command_type in {'conversation.rename', 'conversation.post_message', 'work.create', 'project.create_from_conversation'}:
        require_conversation_access(store, actor, payload.get('conversation_id', ''))
    elif command_type.startswith(('routine.',)):
        require_workspace_actor(actor, store.workspace_id)
    elif command_type.startswith(('work.', 'plan.')):
        work_id = payload.get('work_id', '')
        if command_type == 'work.provide_contribution':
            request = store.contributions.get(str(payload.get('request_id', '')))
            if request is None:
                raise NotFoundError('Contribution request not found')
            work_id = request.work_id
        require_work_access(store, actor, work_id)
        if command_type == 'work.link_conversation':
            require_conversation_access(store, actor, payload.get('conversation_id', ''))
