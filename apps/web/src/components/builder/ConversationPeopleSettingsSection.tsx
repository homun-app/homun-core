/** People and access: honest today — one local session, invites are simulated. */
import { ConversationAvatar } from "./ConversationAvatar";

export function ConversationPeopleSettingsSection() {
  return (
    <>
      <h3>Persone e accessi</h3>
      <p>
        Chi lavora in questo spazio, adesso. Le identità esterne (account, inviti veri,
        ruoli condivisi) arrivano con la distribuzione del prodotto.
      </p>
      <div className="cv-settings-card">
        <strong>In questo browser</strong>
        <p className="cv-people-row">
          <ConversationAvatar name="Fabio" />
          <span>
            Fabio · titolare
            <small>Sessione locale. Ogni azione del motore porta la sua firma.</small>
          </span>
        </p>
      </div>
      <div className="cv-settings-card">
        <strong>Inviti e ruoli simulati</strong>
        <p>
          Puoi provare il percorso di invito dalla squadra: aggiunge persone dimostrative e
          ruoli finti, senza accessi reali. Nessuna email viene inviata.
        </p>
      </div>
    </>
  );
}
