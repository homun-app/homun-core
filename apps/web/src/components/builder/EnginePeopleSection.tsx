/** Impostazioni → Persone: persone, inviti e dispositivi dello spazio.
 *
 * F5 fetta 1 — identità reali del motore: inviti monouso mostrati una volta,
 * revoca persona (grant + sessioni) e revoca dispositivo separata.
 * Fonte: motore. Nessun collaboratore dimostrativo. */
import { useCallback, useEffect, useState } from "react";
import { UsersRound, UserPlus, Ban, MonitorSmartphone } from "lucide-react";

import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  createEnginePersonInvite,
  listEnginePeople,
  listEnginePeopleInvites,
  revokeEngineDevice,
  revokeEnginePerson,
  revokeEnginePersonInvite,
  type EnginePerson,
  type EnginePersonInvite,
} from "@/lib/engine-people-client";

const ROLE_LABEL: Record<string, string> = {
  owner: "Titolare",
  admin: "Amministratore",
  member: "Membro",
};

export function EnginePeopleSection() {
  const status = useEngineStatus();
  const enabled = status.connection === "connected";
  const actorId = "person_fabio";
  const [people, setPeople] = useState<EnginePerson[]>([]);
  const [invites, setInvites] = useState<EnginePersonInvite[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newInvite, setNewInvite] = useState<{ token: string; role: string } | null>(null);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      const [nextPeople, nextInvites] = await Promise.all([
        listEnginePeople(actorId), listEnginePeopleInvites(actorId),
      ]);
      setPeople(nextPeople);
      setInvites(nextInvites);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <section className="st-people" aria-label="Persone dello spazio">
        <h3><UsersRound size={15} /> Persone dello spazio</h3>
        <p className="cw-hint">Motore non connesso: le persone sono disponibili solo a motore attivo.</p>
        <HomunErrorNotice error={error} />
      </section>
    );
  }

  return (
    <section className="st-people" aria-label="Persone dello spazio">
      <h3><UsersRound size={15} /> Persone dello spazio</h3>
      <p className="cw-hint">
        Le persone entrano con un invito monouso e accedono solo ai progetti condivisi
        con loro. Revocare una persona chiude le sue sessioni e i suoi permessi.
      </p>

      {newInvite && (
        <div className="st-people__invite-token" role="status">
          <strong>Invito pronto — mostrato una sola volta:</strong>
          <code>{newInvite.token}</code>
          <p className="cw-hint">
            Chi lo riceve lo usa dalla propria installazione Homun per registrarsi
            come persona e dispositivo (riscatto: POST /v1/session/redeem; l'onboarding
            guidato arriva con il pairing tra app). Scade tra 7 giorni.
          </p>
          <button type="button" className="cs-link" onClick={() => setNewInvite(null)}>
            Chiudi
          </button>
        </div>
      )}

      <div className="st-people__invite-row">
        <SettingsRoleSelect value={inviteRole} onChange={setInviteRole} disabled={busy} />
        <button
          type="button"
          className="cw-primary"
          disabled={busy}
          onClick={() => void act(async () => {
            const invite = await createEnginePersonInvite(actorId, { role: inviteRole });
            setNewInvite({ token: invite.token, role: inviteRole });
          })}
        >
          <UserPlus size={14} /> Invita persona
        </button>
      </div>

      {loading ? (
        <p className="cw-hint">Caricamento dal motore…</p>
      ) : (
        <div className="st-people__list">
          {people.map((person) => (
            <article key={person.id} className="st-person" data-status={person.status}>
              <header>
                <strong>{person.display_name}</strong>
                <small>{ROLE_LABEL[person.role] ?? person.role}
                  {person.status === "revoked" && " · revocata"}</small>
              </header>
              {person.devices.map((device) => (
                <p key={device.id} className="cw-hint">
                  <MonitorSmartphone size={12} /> {device.name || device.id}
                  {device.status === "revoked" && " · revocato"}
                  {device.status !== "revoked" && person.status === "active" && (
                    <button type="button" className="cs-link"
                            disabled={busy}
                            onClick={() => void act(() => revokeEngineDevice(actorId, device.id))}>
                      Revoca dispositivo
                    </button>
                  )}
                </p>
              ))}
              {person.status === "active" && person.role !== "owner" && (
                <div className="cs-actions">
                  <button type="button" className="cw-secondary" disabled={busy}
                          onClick={() => void act(() => revokeEnginePerson(actorId, person.id))}>
                    <Ban size={13} /> Revoca persona
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {invites.some((invite) => invite.status === "active" && !invite.expired) && (
        <div className="st-people__pending">
          <h4>Inviti aperti</h4>
          {invites.filter((invite) => invite.status === "active" && !invite.expired).map((invite) => (
            <p key={invite.id} className="cw-hint">
              {ROLE_LABEL[invite.role] ?? invite.role} · scade il{" "}
              {invite.expires_at ? new Date(invite.expires_at).toLocaleDateString("it-IT") : "—"}
              <button type="button" className="cs-link" disabled={busy}
                      onClick={() => void act(() => revokeEnginePersonInvite(actorId, invite.id))}>
                Annulla invito
              </button>
            </p>
          ))}
        </div>
      )}

      <HomunErrorNotice error={error} />
    </section>
  );
}

function SettingsRoleSelect({
  value, onChange, disabled,
}: { value: "admin" | "member"; onChange: (next: "admin" | "member") => void; disabled?: boolean }) {
  return (
    <label className="st-people__role">
      Ruolo
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as "admin" | "member")}>
        <option value="member">Membro</option>
        <option value="admin">Amministratore</option>
      </select>
    </label>
  );
}
