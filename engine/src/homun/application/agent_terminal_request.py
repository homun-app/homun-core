"""Shared request construction for approved native terminal commands."""
from homun.domain.errors import ValidationError

def proposal_body(run, arguments, proposal_id):
    """Build the same approved terminal request for tools and goal gates."""
    terminal=run['terminal']
    body={'command_id':proposal_id,'command':arguments['command'],'policy':terminal['policy'],
        'timeout_seconds':arguments.get('timeout_seconds',300),'expected_version':run['_run_version']}
    if run.get('execution_context', {}).get('cwd', '.') != '.':
        body['cwd'] = run['execution_context']['cwd']
    ssh_key_path=None
    if terminal['policy']=='local-private-v1':
        if arguments.get('pty'):
            raise ValidationError('A local session has no terminal')
    elif terminal['policy']=='ssh-v1':
        if arguments.get('pty'):
            raise ValidationError('An SSH session has no terminal')
        body.update(ssh_host=terminal['host'], ssh_user=terminal['user'], ssh_port=terminal['port'],
                    ssh_host_key=terminal['host_key'])
        ssh_key_path=terminal['key_path']
    else:
        body['image']=terminal['image']
        if arguments.get('pty') and not arguments.get('background'):
            raise ValidationError('A PTY session must stay in the background')
        if arguments.get('background'):
            body['background']=True
            if terminal.get('version',1)>=4:body['stdin']=True
            if arguments.get('pty'):body['pty']=True
    if terminal['policy'] in {'local-private-v1', 'ssh-v1'} and arguments.get('background'):
        body['background']=True
    return body, ssh_key_path

