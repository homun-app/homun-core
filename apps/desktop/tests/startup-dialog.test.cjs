const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startupDialogDetail } = require('../src/startup-dialog.cjs');

test('workspace-unavailable: names the sqlite verdict, the database in use, and promises no data was touched', () => {
  const message = startupDialogDetail({ startupFailure: {
    reason: 'workspace-unavailable',
    db_path: '/tmp/homun-data/ws_local.sqlite3',
    sqlite_error: 'SQLITE_BUSY',
    detail: 'Il database del workspace non è apribile',
  } });
  assert.match(message, /SQLITE_BUSY/);
  assert.match(message, /\/tmp\/homun-data\/ws_local\.sqlite3/);
  assert.match(message, /nessun dato/i);
});

test('workspace-unavailable without sqlite verdict still explains what to do', () => {
  const message = startupDialogDetail({ startupFailure: { reason: 'workspace-unavailable' } });
  assert.match(message, /database/i);
  assert.match(message, /riavvia/i);
});

test('unknown startup failures keep the generic message', () => {
  assert.match(
    startupDialogDetail({ startupFailure: { reason: 'something-else' } }),
    /Il motore locale non si è avviato/);
  assert.match(startupDialogDetail({}), /Il motore locale non si è avviato/);
});

test('engine-dir-busy messages are unchanged', () => {
  assert.match(
    startupDialogDetail({ startupFailure: { reason: 'engine-dir-busy' } }),
    /processo sconosciuto/);
  assert.match(
    startupDialogDetail({ startupFailure: { reason: 'engine-dir-busy', holder_pid: 42 },
      recovery: { reason: 'foreign-process', holderPid: 42 } }),
    /non è un motore Homun/);
  assert.match(
    startupDialogDetail({ startupFailure: { reason: 'engine-dir-busy', holder_pid: 42 },
      recovery: { killed: false, reason: 'unkillable', holderPid: 42 } }),
    /non è stato possibile terminarlo/);
  assert.match(
    startupDialogDetail({ startupFailure: { reason: 'engine-dir-busy', holder_pid: 42 },
      recovery: { killed: true, recoveredFrom: 42 } }),
    /secondo tentativo/);
});
