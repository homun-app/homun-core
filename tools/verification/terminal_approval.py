"""Opt-in native approval/restart fixture using a locally cached Docker image."""
import argparse
import json
import tempfile
import time
import uuid
from pathlib import Path
from homun.application import terminal_jobs
from homun.application.terminal_contracts import job_spec
from homun.context import create_context
from homun.domain.models import Actor


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--image',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='homun-approval-proof-') as temp:
        root=Path(temp).resolve();db=root/'ws.db'
        ctx=create_context(db_path=db,data_dir=root,for_tests=True)
        actor=Actor(id='proof_owner',workspace_id=ctx.workspace_id,display_name='Proof')
        c=ctx.service.apply(actor,'c','conversation.create',{'title':'Terminal proof'})
        w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'Terminal proof','objective':'Owned command approval'})
        ctx.persist();work=w['work_id']
        body={'command_id':uuid.uuid4().hex,'expected_version':1,'image':args.image,
              'command':'printf "once\\n" >> receipt.txt; printf "approved output\\n"; exit 7'}
        proposal=terminal_jobs.propose(ctx,actor,work,body)
        assert proposal['status']=='pending_approval'
        backend=terminal_jobs.backend_for(ctx);spec=job_spec(ctx,proposal)
        assert not backend.workspace(spec).joinpath('receipt.txt').exists()
        started=False
        try:
            terminal_jobs.approve(ctx,actor,work,proposal['id'],{'digest':proposal['digest']});started=True
            ctx.close();ctx=create_context(db_path=db,data_dir=root,for_tests=True)
            deadline=time.monotonic()+10
            while True:
                result=terminal_jobs.refresh(ctx,actor,work,proposal['id'])
                if result['status']=='exited':break
                assert time.monotonic()<deadline,'Job did not complete'
                time.sleep(.1)
            assert result['exit_code']==7
            assert 'approved output' in result['logs']['text']
            terminal_jobs.approve(ctx,actor,work,proposal['id'],{'digest':proposal['digest']})
            assert backend.workspace(spec).joinpath('receipt.txt').read_text()=='once\n'
            assert terminal_jobs.list_for_work(ctx,actor,work)['items'][0]['status']=='exited'
            evidence={'runtime':'real Docker plus native application and SQLite reopen; no model/UI',
                      'image':args.image,'checks':{'proposal_inert':True,'approved_execution':True,
                      'sqlite_reopen_recovery':True,'exit_7_preserved':True,'logs_recovered':True,
                      'reapproval_no_duplicate_file_effect':True,'persisted_list_state':True}}
        finally:
            if started:backend.remove(spec)
            ctx.close()
        evidence['checks']['owned_container_removed']=True
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence,indent=2))


if __name__=='__main__':main()
