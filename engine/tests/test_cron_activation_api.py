"""Event jobs activate only through authenticated, scoped, idempotent requests."""
from test_agent_runs_api import api_setup
from homun.application.cron_store import CronStore, set_cron_store
from homun.application.cron_manager import CronManager


def test_activation_requires_auth_and_preserves_identity(api_setup, tmp_path):
    ctx, actor, work, client, headers = api_setup
    store = CronStore(tmp_path/'cron.sqlite')
    set_cron_store(store)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id,store=store)
        job = mgr.create_job(schedule='on event:deploy',prompt='Check deployment',
                             owner_actor=actor.model_dump(mode='json'),source_work_id=work)
        url = f'/v1/cron/jobs/{job.id}/activate'
        body = {'workspace_id':ctx.workspace_id,'activation_id':'deploy-42'}
        assert client.post(url,json=body).status_code == 401
        assert mgr.claim_job_for_fire(job.id) is None
        first = client.post(url,headers=headers,json=body)
        assert first.status_code == 200, first.text
        second = client.post(url,headers=headers,json=body)
        assert second.status_code == 200, second.text
        assert second.json()['occurrence']['occurrence_id'] == first.json()['occurrence']['occurrence_id']
        assert mgr.claim_job_for_fire(job.id) is not None
        assert mgr.claim_job_for_fire(job.id) is None
    finally:
        set_cron_store(None)
        store.close()
