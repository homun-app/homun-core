"""Phase resolution and readable history for adaptive executions."""
import json
from homun.domain.errors import ConflictError, DomainError
from homun.policy import require_project_capability


def current_step(store, work):
    if not work.current_plan_revision:
        return None
    plan = store.plans.get(store.plan_key(work.id, work.current_plan_revision))
    if not plan:
        return None
    reviews = sorted((r for r in store.reviews.values() if r.work_id == work.id), key=lambda r: r.created_at)
    if work.status == 'ready' and reviews and reviews[-1].decision == 'request_changes':
        prior = next((r.result for r in store.commands.values()
                      if r.type == 'agent_run.propose' and r.result.get('artifact_id') == reviews[-1].artifact_version_id), None)
        if prior:
            delivered = next((s for s in plan.steps if s.id == prior.get('_step_id')), None)
            # Only until a subsequent revision phase has been inserted.
            if delivered and not any(s.id.startswith(f'{prior["id"]}:revision:') for s in plan.steps):
                return delivered
    step = next((s for s in plan.steps if s.status == 'running'), None)
    step = step or next((s for s in plan.steps if s.status == 'pending'), None)
    # A requested revision reruns the last adaptive phase with new approval.
    if step is None and work.status == 'ready' and plan.steps and plan.steps[-1].capability == 'agent_run':
        step = plan.steps[-1]
    if step is None or step.capability != 'agent_run':
        raise ConflictError('Complete preceding phases before starting adaptive work')
    return step


def history_is_readable(store, actor, run):
    for binding in run['materials']:
        material = store.materials.get(binding['id'])
        if material is None:
            return False
        try:
            require_project_capability(store, actor, material.project_id, 'read')
        except DomainError:
            return False
    return True


def revision_context(store, work):
    reviews = sorted((r for r in store.reviews.values() if r.work_id == work.id), key=lambda r: r.created_at)
    if not reviews or reviews[-1].decision != 'request_changes':
        return None
    review = reviews[-1]
    artifact = store.artifacts.get(review.artifact_version_id)
    prior = next((r.result for r in store.commands.values()
                  if r.type == 'agent_run.propose' and r.result.get('artifact_id') == review.artifact_version_id), {})
    objective = json.loads(prior.get('_objective', '{}'))
    inherited = (objective.get('revision') or {}).get('clarifications', [])
    answers = inherited + [item['result'] for item in prior.get('observations', [])
                           if item.get('tool') == 'human_input']
    clarifications = []
    for answer in answers:
        bounded = {'question': str(answer.get('question', ''))[:1000],
                   'text': str(answer.get('text', ''))[:4000]}
        if bounded in clarifications:
            clarifications.remove(bounded)
        clarifications.append(bounded)
    clarifications = clarifications[-8:]
    return {'comment': review.comment[:4000],
            'previous_content': artifact.content[:16000] if artifact else '',
            'clarifications': clarifications}
