"""Real wall-clock timeout, SQLite reopen and Docker stop verification."""
import argparse,json,tempfile,time,uuid
from datetime import datetime
from pathlib import Path
from homun.application import terminal_jobs
from homun.application.terminal_contracts import job_spec
from homun.application.terminal_watchdog import reconcile
from homun.context import create_context
from homun.domain.models import Actor,utc_now


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='homun-deadline-') as tmp:
        root=Path(tmp).resolve();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
        actor=Actor(id='proof',workspace_id=ctx.workspace_id,display_name='Proof')
        c=ctx.service.apply(actor,'c','conversation.create',{'title':'Deadline proof'})
        work=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'Deadline proof','objective':'Stop timed job'})['work_id'];ctx.persist()
        p=terminal_jobs.propose(ctx,actor,work,{'command_id':uuid.uuid4().hex,'image':args.image,
            'command':'printf "started\\n" >> once.txt; sleep 60','expected_version':1,'timeout_seconds':2})
        backend=terminal_jobs.backend_for(ctx);spec=job_spec(ctx,p)
        started=False
        try:
            result=terminal_jobs.approve(ctx,actor,work,p['id'],{'digest':p['digest']});started=True
            assert result['status']=='running'
            deadline=datetime.fromisoformat(result['deadline_at'])
            ctx.close();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
            time.sleep(max(0,(deadline-utc_now()).total_seconds())+.1)
            reconcile(ctx)
            result=terminal_jobs.list_for_work(ctx,actor,work)['items'][0]
            assert result['status']=='exited' and result['timed_out'] and not result['running']
            assert 'started' in result['logs']['text'] or (backend.workspace(spec)/'once.txt').read_text()=='started\n'
            reconcile(ctx)
            terminal_jobs.approve(ctx,actor,work,p['id'],{'digest':p['digest']})
            assert (backend.workspace(spec)/'once.txt').read_text()=='started\n'
            evidence={'runtime':'real Docker, wall clock and SQLite reopen','timeout_seconds':2,
                'status':result['status'],'exit_code':result['exit_code'],'timed_out':result['timed_out'],
                'checks':{'deadline_survives_restart':True,'expired_container_stopped':True,'no_reexecution':True},
                'limitation':'Engine must run to enforce the deadline; engine-off time is reconciled on restart.'}
        finally:
            if started:backend.remove(spec)
            ctx.close()
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))


if __name__=='__main__':main()
