"""The data-dir lease names the process that owns the directory."""
import fcntl
import json
import os
from pathlib import Path

import pytest

from homun.storage.lease import EngineBusyError, engine_lease


def test_lease_records_owner_pid_in_lock_file(tmp_path):
    with engine_lease(tmp_path):
        record = json.loads((tmp_path / 'engine.lock').read_text())
    assert record['pid'] == os.getpid()


def test_refused_lease_names_the_recorded_holder(tmp_path):
    announced = []
    with engine_lease(tmp_path):
        with pytest.raises(EngineBusyError) as caught:
            with engine_lease(tmp_path, on_busy=announced.append):
                raise AssertionError('second lease acquired')
    assert caught.value.holder_pid == os.getpid()
    assert announced == [caught.value]


def test_holder_without_pid_record_is_reported_unknown(tmp_path):
    data_dir = tmp_path / 'dir'
    data_dir.mkdir()
    fd = os.open(data_dir / 'engine.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # a holder predating pid recording
        with pytest.raises(EngineBusyError) as caught:
            with engine_lease(data_dir):
                raise AssertionError('second lease acquired')
        assert caught.value.holder_pid is None
    finally:
        os.close(fd)
