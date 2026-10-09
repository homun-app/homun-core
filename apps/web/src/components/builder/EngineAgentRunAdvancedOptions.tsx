/**
 * IT-facing prepare options kept off the happy path (MCP, Docker/SSH, code, toggles).
 */
import type { Dispatch, SetStateAction } from "react";
import { EngineAgentServerPicker } from "./EngineAgentServerPicker";

type Props = {
  busy: boolean;
  renew: () => void;
  serverIds: string[];
  setServerIds: Dispatch<SetStateAction<string[]>>;
  webPages: boolean;
  setWebPages: Dispatch<SetStateAction<boolean>>;
  ownedBrowser: boolean;
  setOwnedBrowser: Dispatch<SetStateAction<boolean>>;
  localTerminal: boolean;
  setLocalTerminal: Dispatch<SetStateAction<boolean>>;
  sshTerminal: boolean;
  setSshTerminal: Dispatch<SetStateAction<boolean>>;
  terminalImage: string;
  setTerminalImage: Dispatch<SetStateAction<string>>;
  terminalValid: boolean;
  sshHost: string;
  setSshHost: Dispatch<SetStateAction<string>>;
  sshUser: string;
  setSshUser: Dispatch<SetStateAction<string>>;
  sshPort: string;
  setSshPort: Dispatch<SetStateAction<string>>;
  sshKeyPath: string;
  setSshKeyPath: Dispatch<SetStateAction<string>>;
  sshHostKey: string;
  setSshHostKey: Dispatch<SetStateAction<string>>;
  memory: boolean;
  setMemory: Dispatch<SetStateAction<boolean>>;
  skills: boolean;
  setSkills: Dispatch<SetStateAction<boolean>>;
  delegation: boolean;
  setDelegation: Dispatch<SetStateAction<boolean>>;
  clarify: boolean;
  setClarify: Dispatch<SetStateAction<boolean>>;
  codeExecution: boolean;
  setCodeExecution: Dispatch<SetStateAction<boolean>>;
};

export function EngineAgentRunAdvancedOptions({
  busy,
  renew,
  serverIds,
  setServerIds,
  webPages,
  setWebPages,
  ownedBrowser,
  setOwnedBrowser,
  localTerminal,
  setLocalTerminal,
  sshTerminal,
  setSshTerminal,
  terminalImage,
  setTerminalImage,
  terminalValid,
  sshHost,
  setSshHost,
  sshUser,
  setSshUser,
  sshPort,
  setSshPort,
  sshKeyPath,
  setSshKeyPath,
  sshHostKey,
  setSshHostKey,
  memory,
  setMemory,
  skills,
  setSkills,
  delegation,
  setDelegation,
  clarify,
  setClarify,
  codeExecution,
  setCodeExecution,
}: Props) {
  return (
    <details className="cw-run-advanced">
      <summary>Opzioni avanzate — solo se sai cosa stai autorizzando</summary>
      <p>
        Per lettura e sintesi di materiali bastano i documenti scelti sopra. Queste opzioni aprono
        rete, browser, terminali e strumenti esterni.
      </p>

      <label>
        <input
          type="checkbox"
          checked={webPages}
          disabled={busy}
          onChange={(e) => {
            renew();
            setWebPages(e.target.checked);
          }}
        />{" "}
        Leggi pagine web pubbliche
      </label>
      {webPages && (
        <p>
          Homun può cercare sul web pubblico e leggere il testo di una pagina http. Gli indirizzi
          privati sono rifiutati. La ricerca non entra negli account.
        </p>
      )}

      <label>
        <input
          type="checkbox"
          checked={ownedBrowser}
          disabled={busy}
          onChange={(e) => {
            renew();
            setOwnedBrowser(e.target.checked);
          }}
        />{" "}
        Apri un browser privato, senza il tuo profilo
      </label>
      {ownedBrowser && (
        <p>
          Homun avvia un browser separato e lo tiene aperto per questo lavoro. Non usa il profilo di
          Chrome di questo computer e non fotografa lo schermo.
        </p>
      )}

      <details>
        <summary>Server MCP e strumenti esterni</summary>
        <EngineAgentServerPicker
          selected={serverIds}
          disabled={busy}
          onChange={(ids) => {
            renew();
            setServerIds(ids);
          }}
        />
      </details>

      <details>
        <summary>Terminale (Docker / SSH / locale)</summary>
        <p>Consenti a Homun di proporre comandi. Ogni comando richiederà la tua approvazione.</p>
        <label>
          <input
            type="checkbox"
            checked={localTerminal}
            disabled={busy}
            onChange={(e) => {
              renew();
              setLocalTerminal(e.target.checked);
              if (e.target.checked) setSshTerminal(false);
            }}
          />{" "}
          Esegui su questo computer, senza container
        </label>
        <label>
          <input
            type="checkbox"
            checked={sshTerminal}
            disabled={busy}
            onChange={(e) => {
              renew();
              setSshTerminal(e.target.checked);
              if (e.target.checked) setLocalTerminal(false);
            }}
          />{" "}
          Esegui via SSH su un host approvato
        </label>
        {sshTerminal && (
          <>
            <p>
              Ogni comando resta da approvare. Homun non usa la configurazione SSH di questo computer
              e non copia i file.
            </p>
            <label>
              Host
              <input
                value={sshHost}
                disabled={busy}
                onChange={(e) => {
                  renew();
                  setSshHost(e.target.value.trim());
                }}
              />
            </label>
            <label>
              Utente
              <input
                value={sshUser}
                disabled={busy}
                onChange={(e) => {
                  renew();
                  setSshUser(e.target.value.trim());
                }}
              />
            </label>
            <label>
              Porta
              <input
                value={sshPort}
                disabled={busy}
                onChange={(e) => {
                  renew();
                  setSshPort(e.target.value.trim());
                }}
              />
            </label>
            <label>
              Percorso della chiave privata
              <input
                value={sshKeyPath}
                disabled={busy}
                onChange={(e) => {
                  renew();
                  setSshKeyPath(e.target.value.trim());
                }}
              />
            </label>
            <label>
              Chiave pubblica del server
              <input
                value={sshHostKey}
                disabled={busy}
                onChange={(e) => {
                  renew();
                  setSshHostKey(e.target.value.trim());
                }}
              />
            </label>
          </>
        )}
        {localTerminal ? (
          <p>
            I comandi usano la cartella del lavoro e non ereditano le variabili d&apos;ambiente. Non
            sono isolati dalla rete né dai percorsi assoluti.
          </p>
        ) : sshTerminal ? null : (
          <>
            <p>
              Serve Docker locale con un&apos;immagine già presente; non verrà scaricata
              automaticamente.
            </p>
            <label>
              Identificativo completo dell&apos;immagine Docker
              <input
                value={terminalImage}
                disabled={busy}
                placeholder="sha256:…"
                onChange={(e) => {
                  renew();
                  setTerminalImage(e.target.value.trim());
                }}
              />
            </label>
            {!terminalValid && (
              <p role="alert">
                Inserisci sha256: seguito dalle 64 cifre esadecimali dell&apos;immagine.
              </p>
            )}
          </>
        )}
      </details>

      <details>
        <summary>Capacità del collaboratore</summary>
        <p>Valori consigliati già attivi per un incarico tipico:</p>
        <label>
          <input
            type="checkbox"
            checked={memory}
            disabled={busy}
            onChange={(e) => {
              renew();
              setMemory(e.target.checked);
            }}
          />{" "}
          Memoria di progetto
        </label>
        <label>
          <input
            type="checkbox"
            checked={skills}
            disabled={busy}
            onChange={(e) => {
              renew();
              setSkills(e.target.checked);
            }}
          />{" "}
          Competenze approvate
        </label>
        <label>
          <input
            type="checkbox"
            checked={delegation}
            disabled={busy}
            onChange={(e) => {
              renew();
              setDelegation(e.target.checked);
            }}
          />{" "}
          Deleghe a collaboratori specializzati
        </label>
        <label>
          <input
            type="checkbox"
            checked={clarify}
            disabled={busy}
            onChange={(e) => {
              renew();
              setClarify(e.target.checked);
            }}
          />{" "}
          Chiarimenti strutturati
        </label>
        <label>
          <input
            type="checkbox"
            checked={codeExecution}
            disabled={busy}
            onChange={(e) => {
              renew();
              setCodeExecution(e.target.checked);
            }}
          />{" "}
          Esecuzione script Python (programmatica)
        </label>
      </details>
    </details>
  );
}
