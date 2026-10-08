import pytest


def spec(**changes):
    from homun.execution.contracts import JobSpec
    return JobSpec(**({'workspace_id':'ws','run_id':'run','call_id':'call',
        'image':'sha256:'+'a'*64,'command':'printf hello'} | changes))


class FakeDocker:
    def __init__(self):
        self.calls=[];self.row=None
    def run(self,args,**kwargs):
        import json
        from homun.execution.cli import Reply
        self.calls.append(args)
        if args[:2]==['container','inspect']:
            return Reply(0,json.dumps([self.row]),False) if self.row else Reply(1,'No such container',False)
        if args[0]=='run':
            labels=dict(args[i+1].split('=',1) for i,v in enumerate(args) if v=='--label')
            self.row={'Id':'c'*64,'Config':{'Labels':labels},'State':{'Status':'running','Running':True,'ExitCode':0,'OOMKilled':False}}
            return Reply(0,'c'*64,False)
        if args[0]=='stop':
            self.row['State'].update(Status='exited',Running=False,ExitCode=137)
        if args[0]=='rm':self.row=None
        return Reply(0,'hello',False)


def test_start_is_durable_and_does_not_restart_after_backend_recreation(tmp_path):
    from homun.execution.docker import DockerJobs
    docker=FakeDocker();job=spec()
    first=DockerJobs(tmp_path,client=docker)
    assert first.start(job)['status']=='running'
    second=DockerJobs(tmp_path,client=docker)
    assert second.start(job)['status']=='running'
    assert sum(c[0]=='run' for c in docker.calls)==1
    argv=next(c for c in docker.calls if c[0]=='run')
    assert '--pull=never' in argv and '--network=none' in argv and '--cap-drop=ALL' in argv
    assert argv[-3:]==[job.image,'-lc',job.command]


def test_removed_or_missing_job_is_never_redispatched(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.execution.contracts import ExecutionUncertain
    docker=FakeDocker();backend=DockerJobs(tmp_path,client=docker);job=spec()
    backend.start(job);backend.remove(job)
    with pytest.raises(ExecutionUncertain):backend.start(job)
    assert sum(c[0]=='run' for c in docker.calls)==1


def test_changed_contract_and_foreign_owner_rejected(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.domain.errors import ConflictError, PermissionDeniedError
    docker=FakeDocker();backend=DockerJobs(tmp_path,client=docker);job=spec();backend.start(job)
    with pytest.raises(ConflictError):backend.start(job.model_copy(update={'command':'different'}))
    docker.row['Config']['Labels']['io.homun.owner']='foreign'
    before=len(docker.calls)
    with pytest.raises(PermissionDeniedError):backend.stop(job)
    assert not any(c[0]=='stop' for c in docker.calls[before:])


def test_workspace_symlink_is_not_mounted(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.domain.errors import PermissionDeniedError
    backend=DockerJobs(tmp_path,client=FakeDocker());job=spec()
    workspace=backend.workspace(job);workspace.rmdir();workspace.symlink_to(tmp_path)
    with pytest.raises(PermissionDeniedError):backend.start(job)


def test_image_must_be_content_pinned():
    from homun.execution.contracts import JobSpec
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        JobSpec(workspace_id='ws',run_id='run',call_id='call',image='debian:latest',command='true')


def test_timeout_after_dispatch_reconciles_without_repeating(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.execution.contracts import ExecutionTimeout
    class TimeoutDocker(FakeDocker):
        def run(self,args,**kwargs):
            reply=super().run(args,**kwargs)
            if args[0]=='run':raise ExecutionTimeout('timeout')
            return reply
    docker=TimeoutDocker();job=spec();backend=DockerJobs(tmp_path,client=docker)
    assert backend.start(job)['running']
    assert backend.start(job)['running']
    assert sum(c[0]=='run' for c in docker.calls)==1


def test_lost_container_after_timeout_is_uncertain_forever(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.execution.contracts import ExecutionTimeout, ExecutionUncertain
    class LostDocker(FakeDocker):
        def run(self,args,**kwargs):
            if args[0]=='run':
                self.calls.append(args)
                raise ExecutionTimeout('timeout')
            return super().run(args,**kwargs)
    docker=LostDocker();job=spec()
    for _ in range(2):
        with pytest.raises(ExecutionUncertain):DockerJobs(tmp_path,client=docker).start(job)
    assert sum(c[0]=='run' for c in docker.calls)==1


def test_exited_job_is_returned_without_restart(tmp_path):
    from homun.execution.docker import DockerJobs
    docker=FakeDocker();job=spec();backend=DockerJobs(tmp_path,client=docker)
    backend.start(job)
    docker.row['State'].update(Status='exited',Running=False,ExitCode=7)
    assert backend.start(job)['exit_code']==7
    assert sum(c[0]=='run' for c in docker.calls)==1


def test_unavailable_daemon_does_not_mean_missing_container(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.execution.cli import Reply
    from homun.execution.contracts import ExecutionUnavailable
    class OfflineDocker(FakeDocker):
        def run(self,args,**kwargs):
            self.calls.append(args)
            return Reply(1,'Cannot connect to the Docker daemon',False)
    docker=OfflineDocker()
    with pytest.raises(ExecutionUnavailable):DockerJobs(tmp_path,client=docker).start(spec())
    assert not any(c[0]=='run' for c in docker.calls)


def test_incomplete_intent_fails_closed(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.execution.contracts import ExecutionUncertain
    docker=FakeDocker();backend=DockerJobs(tmp_path,client=docker);job=spec()
    (tmp_path/'intents').mkdir()
    (tmp_path/'intents'/f'{job.identity}.json').write_text('{')
    with pytest.raises(ExecutionUncertain):backend.start(job)
    assert not docker.calls


def test_stop_uses_verified_id_and_logs_are_bounded(tmp_path):
    from homun.execution.docker import DockerJobs
    docker=FakeDocker();backend=DockerJobs(tmp_path,client=docker);job=spec();backend.start(job)
    assert backend.logs(job)['tail_only']
    assert backend.stop(job)['exit_code']==137
    assert ['stop','--time','5','c'*64] in docker.calls


def test_cli_drains_but_retains_bounded_output():
    import sys
    from homun.execution.cli import DockerCLI
    reply=DockerCLI(sys.executable).run(['-c',"import sys;sys.stdout.write('x'*2000000)"],max_bytes=1024)
    assert reply.returncode==0 and reply.truncated and len(reply.output)==1024


def test_cli_timeout_is_typed():
    import sys
    from homun.execution.cli import DockerCLI
    from homun.execution.contracts import ExecutionTimeout
    with pytest.raises(ExecutionTimeout):
        DockerCLI(sys.executable).run(['-c','import time;time.sleep(20)'],timeout=0.05)


@pytest.mark.parametrize('operation',['logs','remove'])
def test_foreign_container_cannot_be_read_or_removed(tmp_path,operation):
    from homun.execution.docker import DockerJobs
    from homun.domain.errors import PermissionDeniedError
    docker=FakeDocker();backend=DockerJobs(tmp_path,client=docker);job=spec();backend.start(job)
    docker.row['Config']['Labels']['io.homun.owner']='foreign'
    docker.calls.clear()
    with pytest.raises(PermissionDeniedError):getattr(backend,operation)(job)
    assert all(c[:2]==['container','inspect'] for c in docker.calls)


def test_concurrent_start_has_only_one_dispatch(tmp_path):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from homun.execution.docker import DockerJobs
    from homun.execution.contracts import ExecutionUncertain
    entered=threading.Event();release=threading.Event()
    class HeldDocker(FakeDocker):
        def run(self,args,**kwargs):
            if args[0]=='run':
                entered.set()
                assert release.wait(5)
            return super().run(args,**kwargs)
    docker=HeldDocker();job=spec()
    with ThreadPoolExecutor(max_workers=1) as pool:
        first=pool.submit(DockerJobs(tmp_path,client=docker).start,job)
        try:
            assert entered.wait(5)
            with pytest.raises(ExecutionUncertain):DockerJobs(tmp_path,client=docker).start(job)
        finally:release.set()
        assert first.result()['running']
    assert sum(c[0]=='run' for c in docker.calls)==1


def test_different_storage_root_cannot_adopt_same_job(tmp_path):
    from homun.execution.docker import DockerJobs
    from homun.domain.errors import PermissionDeniedError
    docker=FakeDocker();job=spec()
    DockerJobs(tmp_path/'first',client=docker).start(job)
    with pytest.raises(PermissionDeniedError):DockerJobs(tmp_path/'other',client=docker).start(job)
    assert sum(c[0]=='run' for c in docker.calls)==1
