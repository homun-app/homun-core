// OA5 (fase onboarding-a): il segnale con cui un turno di chat si TRATTIENE
// perché non c'è un modello. Il messaggio dell'utente è già nel transcript:
// il job non fallisce e non si ripete — torna in coda, lontanissimo
// (payload.waitingModel), e riparte da solo una volta sola quando un modello
// valido viene salvato. Solo il worker della coda lo cattura.
export class TurnHeldForModel extends Error {
  constructor() {
    super('turn held: waiting for a model')
    this.name = 'TurnHeldForModel'
  }
}
