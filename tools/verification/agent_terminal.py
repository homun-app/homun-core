"""Real Ollama + owned Docker + native canonical resume; isolated fixture only."""
import argparse,json,tempfile,time,uuid
from pathlib import Path
from homun.context import create_context
from homun.domain.models import Actor
from homun.application import agent_runs,agent_terminal,terminal_jobs
from homun.application.agent_run_execution import advance
from homun.application.terminal_contracts import job_spec


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    command='printf "proof-once\\n" >> proof.txt; printf "HOMUN_TERMINAL_OK\\n"'
    with tempfile.TemporaryDirectory(prefix='homun-agent-terminal-') as temp:
        root=Path(temp).resolve();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
        ctx.models.apply_ollama_preset(model='qwen3.5:4b')
        actor=Actor(id='proof',workspace_id=ctx.workspace_id,display_name='Proof')
        c=ctx.service.apply(actor,'c','conversation.create',{'title':'Native terminal proof'})
        w=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'Native terminal proof',
            'objective':f'Use terminal_execute exactly once to execute this exact command: {command}. After the result, report the observed stdout and exit code. Do not run additional commands.'})['work_id']
        ctx.persist()
        p=agent_runs.propose(ctx,actor,w,{'command_id':uuid.uuid4().hex,'expected_version':1,'material_ids':[],'terminal_image':args.image})
        agent_runs.approve(ctx,actor,w,p['id'],{'command_id':'approve-run','expected_version':p['expected_version'],'digest':p['digest']})
        job=None;backend=None
        try:
            for _ in range(5):
                status=advance(ctx,p['id'])
                if status=='waiting_external':break
                assert status=='running',status
            run=ctx.repository.load().commands[p['id']].result
            job=ctx.repository.load().commands[run['terminal_request_id']].result
            assert job['command']==command,'Model did not propose the authorized fixture command'
            backend=terminal_jobs.backend_for(ctx);spec=job_spec(ctx,job)
            assert not (backend.workspace(spec)/'proof.txt').exists()
            terminal_jobs.approve(ctx,actor,w,job['id'],{'digest':job['digest']})
            ctx.close();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
            ctx.models.apply_ollama_preset(model='qwen3.5:4b')
            deadline=time.monotonic()+15
            while not agent_terminal.resume(ctx,p['id']):
                assert time.monotonic()<deadline
                time.sleep(.1)
            assert not agent_terminal.resume(ctx,p['id'])
            for _ in range(5):
                status=advance(ctx,p['id'])
                if status=='completed':break
                assert status=='running',status
            assert status=='completed'
            run=ctx.repository.load().commands[p['id']].result
            terminal_jobs.approve(ctx,actor,w,job['id'],{'digest':job['digest']})
            assert (backend.workspace(spec)/'proof.txt').read_text()=='proof-once\n'
            messages=run['_messages'];receipts=[m for m in messages if m.get('tool_call_id')==job['_agent_binding']['call_id']]
            assert len(receipts)==1 and 'HOMUN_TERMINAL_OK' in receipts[0]['content']
            artifacts=ctx.repository.load().artifacts
            assert len(artifacts)==1
            evidence={'model':'qwen3.5:4b via local Ollama','image':args.image,'checks':{'real_model_proposed_exact_command':True,
                'no_effect_before_approval':True,'sqlite_restart_resume':True,'one_canonical_receipt':True,
                'no_duplicate_effect_on_reapproval':True,'final_artifact':True},'final_message':messages[-1]['content']}
            assert 'HOMUN_TERMINAL_OK' in evidence['final_message']
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(evidence,indent=2)+'\n')
            print(json.dumps(evidence,indent=2))
        finally:
            if backend and job:
                backend.remove(job_spec(ctx,job))
            ctx.close()


if __name__=='__main__':main()
