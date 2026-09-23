from types import SimpleNamespace
from unittest.mock import patch
import pytest
from homun.application.routines import reconcile_routine_schedules


@pytest.mark.parametrize('status', ['active', 'paused'])
@pytest.mark.parametrize('drift', ['cron', 'timezone', 'missing'])
def test_schedule_definition_repaired_preserving_domain_pause(status, drift):
    routine = SimpleNamespace(id='r1', status=status, cron='0 12 * * *', cron_timezone='Europe/Rome')
    ctx = SimpleNamespace(repository=SimpleNamespace(load=lambda: SimpleNamespace(routines={'r1': routine})))
    existing = [] if drift == 'missing' else [{'schedule_name': 'routine:r1',
        'status': 'PAUSED' if status == 'paused' else 'ACTIVE',
        'schedule': '0 8 * * *' if drift == 'cron' else routine.cron,
        'cron_timezone': 'UTC' if drift == 'timezone' else routine.cron_timezone}]
    with patch('dbos.DBOS.list_schedules', return_value=existing), \
         patch('dbos.DBOS.create_schedule') as create, \
         patch('dbos.DBOS.delete_schedule') as delete, \
         patch('dbos.DBOS.pause_schedule') as pause:
        assert reconcile_routine_schedules(ctx) == ['r1']
        assert create.call_args.kwargs['schedule'] == routine.cron
        assert create.call_args.kwargs['cron_timezone'] == routine.cron_timezone
        assert delete.call_count == (0 if drift == 'missing' else 1)
        assert pause.call_count == (1 if status == 'paused' else 0)
