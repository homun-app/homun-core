/** User-facing dialog copy for engine startup failures (pure, testable). */

function startupDialogDetail(info) {
  const failure = info?.startupFailure, recovery = info?.recovery;
  if (failure?.reason === 'workspace-unavailable') {
    const verdict = failure.sqlite_error ? ` (${failure.sqlite_error})` : '';
    return 'Il database del workspace non è apribile e non risulta corrotto' + verdict + ': ' +
      'nessun dato è stato spostato o modificato.' +
      (failure.db_path ? `\n\nDatabase in uso: ${failure.db_path}` : '') +
      '\n\nChiudi gli altri processi che potrebbero usarlo, controlla permessi e spazio su disco, poi riavvia Homun.';
  }
  if (failure?.reason !== 'engine-dir-busy') {
    return 'Il motore locale non si è avviato. Controlla che la directory non sia già in uso.';
  }
  if (!Number.isInteger(failure.holder_pid)) {
    return 'La directory dati è occupata da un processo sconosciuto. Chiudi Homun e riprova.';
  }
  if (recovery?.reason === 'foreign-process') {
    return `La directory dati è occupata dal processo ${failure.holder_pid}, che non è un motore Homun: non posso terminarlo automaticamente.`;
  }
  if (recovery && !recovery.killed) {
    return `La directory dati è occupata dal processo ${failure.holder_pid} e non è stato possibile terminarlo. Chiudi Homun e riprova.`;
  }
  return `La directory dati era occupata da un motore rimasto attivo (PID ${failure.holder_pid}): l'ho terminato, ma il motore non si è avviato al secondo tentativo.`;
}

module.exports = { startupDialogDetail };
