"""Real local model + Docker + immutable file delivery and restart proof."""
import argparse,json,tempfile,time,uuid
from pathlib import Path
from homun.context import create_context
from homun.domain.models import Actor
from homun.application import agent_runs,agent_terminal,terminal_jobs,workspace_files,work_outputs
from homun.application.agent_run_execution import advance
from homun.application.terminal_contracts import job_spec
from homun.application.material_ingest import recover_materials


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();command='echo HOMUN_FILE_OK > result.txt'
    with tempfile.TemporaryDirectory(prefix='homun-agent-files-') as temp:
        root=Path(temp).resolve();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
        ctx.models.apply_ollama_preset(model='qwen3.5:4b')
        actor=Actor(id='proof',workspace_id=ctx.workspace_id,display_name='Proof')
        c=ctx.service.apply(actor,'c','conversation.create',{'title':'File delivery proof'})
        work=ctx.service.apply(actor,'w','work.create',{'conversation_id':c['conversation_id'],'title':'Deliver a file',
            'objective':f'Use terminal_execute exactly once with this exact command: {command}. Then read_workspace_file path result.txt to obtain its SHA256. Then deliver_workspace_file path result.txt using the exact SHA256 returned by read_workspace_file. Finally report the delivered filename. Do not run other commands.'})['work_id'];ctx.persist()
        p=agent_runs.propose(ctx,actor,work,{'command_id':uuid.uuid4().hex,'expected_version':1,'material_ids':[],'terminal_image':args.image})
        agent_runs.approve(ctx,actor,work,p['id'],{'command_id':'approve-run','expected_version':p['expected_version'],'digest':p['digest']})
        jobs=[]
        try:
            for _ in range(12):
                status=advance(ctx,p['id'])
                print('step',status,flush=True)
                if status=='completed':break
                if status=='waiting_external':
                    run=ctx.repository.load().commands[p['id']].result
                    job=ctx.repository.load().commands[run['terminal_request_id']].result
                    assert job['command']==command and not jobs,'Unexpected fixture command'
                    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']});jobs.append(job)
                    deadline=time.monotonic()+15
                    while not agent_terminal.resume(ctx,p['id']):
                        assert time.monotonic()<deadline;time.sleep(.1)
                else:assert status=='running',status
            assert status=='completed','Model did not complete'
            outputs=work_outputs.list_for_work(ctx,actor,work)['items'];assert len(outputs)==1
            out=outputs[0];assert out['filename']=='result.txt'
            assert work_outputs.download(ctx,actor,work,out['id'])[1]==b'HOMUN_FILE_OK\n'
            run=ctx.repository.load().commands[p['id']].result
            (workspace_files.root_for(ctx,run)/'result.txt').write_text('later change')
            recover_materials(ctx)
            ctx.close();ctx=create_context(db_path=root/'ws.db',data_dir=root,for_tests=True)
            assert work_outputs.download(ctx,actor,work,out['id'])[1]==b'HOMUN_FILE_OK\n'
            assert len(ctx.repository.load().artifacts)==1
            evidence={'model':'qwen3.5:4b via local Ollama','image':args.image,'output':out,
                'checks':{'real_model_created_read_delivered_file':True,'exact_approved_command':True,
                'download_matches_bytes':True,'workspace_mutation_does_not_change_delivery':True,
                'recovery_and_sqlite_reopen_preserve_output':True,'final_artifact':True},
                'tools':[o['tool'] for o in run['observations']]}
            args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
        finally:
            for job in jobs:terminal_jobs.backend_for(ctx).remove(job_spec(ctx,job))
            ctx.close()


if __name__=='__main__':main()
