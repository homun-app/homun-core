"""Opt-in real Docker fixture. Uses a supplied cached image ID; never pulls."""
from __future__ import annotations
import argparse
import json
import tempfile
import time
import uuid
from pathlib import Path

from homun.execution.contracts import ExecutionUncertain, JobSpec
from homun.execution.docker import DockerJobs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='homun-terminal-proof-') as temporary:
        root = Path(temporary).resolve()
        backend = DockerJobs(root)
        identity = uuid.uuid4().hex
        def job(call, command):
            return JobSpec(workspace_id=identity,run_id='proof',call_id=call,image=args.image,command=command)
        first = job('file', 'printf "once\\n" >> counter.txt; printf "hello from Homun\\n"; exit 7')
        background = job('background', 'sleep 120')
        started = []
        proof = {'image': args.image, 'runtime': 'real Docker, no model/API/UI', 'checks': {}}
        def completed(spec):
            deadline = time.monotonic()+10
            while time.monotonic()<deadline:
                state = backend.inspect(spec)
                if not state['running']: return state
                time.sleep(.1)
            raise AssertionError('Fixture failed to finish')
        try:
            backend.start(first); started.append(first)
            assert completed(first)['exit_code']==7
            proof['checks']['nonzero_exit_preserved']=True
            text = backend.logs(first)['text']
            assert 'hello from Homun' in text
            assert DockerJobs(root).start(first)['exit_code']==7
            assert (backend.workspace(first)/'counter.txt').read_text()=='once\n'
            proof['checks']['restart_did_not_repeat_effect']=True
            proof['checks']['scoped_file_and_logs']=True
            backend.start(background);started.append(background)
            assert backend.inspect(background)['running']
            assert not backend.stop(background)['running']
            proof['checks']['background_stop']=True
            assert backend.inspect(first)['exit_code']==7
            proof['checks']['sibling_unchanged']=True
            backend.remove(first);started.remove(first)
            try: backend.start(first)
            except ExecutionUncertain: pass
            else: raise AssertionError('Removed command redispatched')
            proof['checks']['removed_job_not_redispatched']=True
        finally:
            for spec in started: backend.remove(spec)
        proof['checks']['owned_containers_removed']=True
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(proof,indent=2)+'\n')
        print(json.dumps(proof,indent=2))


if __name__=='__main__': main()
