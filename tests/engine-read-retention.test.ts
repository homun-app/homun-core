/**
 * Ritenzione dei dati consegnati dal motore quando una lettura fallisce.
 *
 * La politica è unica (`engine-read-retention`) e la usano sia lo snapshot
 * del workspace (`useEngineWorkspaceSnapshot`) sia il thread aperto
 * (`useEngineTranscript`, stesso predicato): qui si fissano entrambi i rami
 * con i codici reali del client.
 * - errore di connessione (`engine_unavailable`) → i dati consegnati restano;
 * - accesso negato / sessione revocata e ogni altro codice → tutto scartato.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyEngineWorkspaceCollections,
  isEngineConnectionLoss,
  workspaceAfterReadFailure,
  type EngineWorkspaceCollections,
} from "../apps/web/src/lib/engine-read-retention.ts";
import { homunErrorFromHttp, HomunClientError } from "../apps/web/src/lib/homun-errors.ts";
import { EngineUnavailableError } from "../apps/web/src/lib/engine-client.ts";

const connectionLossFromHttp = () =>
  homunErrorFromHttp(
    503,
    {
      detail: {
        code: "engine_unavailable",
        message: "Engine unreachable at http://127.0.0.1:8765",
      },
    },
    "offline",
  );

const denied = () =>
  homunErrorFromHttp(403, { detail: { code: "permission_denied", message: "Revoked" } }, "denied");

const revoked = () =>
  homunErrorFromHttp(
    401,
    { detail: { code: "unauthorized", message: "Session expired" } },
    "revoked",
  );

/** Uno snapshot pieno: ogni collezione con almeno un elemento. */
const populatedSnapshot = (): EngineWorkspaceCollections => ({
  rawWorks: [{ id: "work-1", title: "Listini", status: "running", version: 3 }],
  projects: [{ id: "proj-1", name: "Progetto Listini", status: "active" }],
  agents: [{ id: "agent-1", name: "Homun", status: "active" }],
  teams: [{ id: "team-1", name: "Squadra", status: "active" }],
  routines: [{ id: "rout-1", name: "Routine", status: "active" }],
  followups: [
    {
      commandId: "cmd-1",
      status: "retry_scheduled",
      errorCode: null,
      attempts: 1,
      conversationId: "conv-1",
      conversationTitle: "Listini",
    },
  ],
});

test("errore di connessione: l'ultimo snapshot consegnato resta, stesso riferimento", () => {
  const snapshot = populatedSnapshot();
  // il guasto reale del client, sia dalla mappatura HTTP…
  assert.equal(workspaceAfterReadFailure(connectionLossFromHttp(), snapshot), snapshot);
  // …sia dalla classe che avvolge i fetch caduti in domainFetch/engineFetch
  assert.equal(
    workspaceAfterReadFailure(new EngineUnavailableError("Engine unreachable"), snapshot),
    snapshot,
  );
});

test("accesso negato o sessione revocata: lavori, conversazioni, progetti, agenti, team, routine e followup svuotati", () => {
  const snapshot = populatedSnapshot();
  for (const cause of [denied(), revoked()]) {
    const retained = workspaceAfterReadFailure(cause, snapshot);
    assert.deepEqual(retained, emptyEngineWorkspaceCollections());
    assert.deepEqual(Object.keys(retained).sort(), [
      "agents",
      "followups",
      "projects",
      "rawWorks",
      "routines",
      "teams",
    ]);
  }
});

test("il thread resta consegnato solo a motore irraggiungibile: ogni altro codice lo scarta", () => {
  // useEngineTranscript conserva il thread consegnato solo quando il predicato
  // riconosce la caduta della connessione: lo stesso check vale per ogni
  // codice tipizzato del client.
  assert.equal(isEngineConnectionLoss(connectionLossFromHttp()), true);
  assert.equal(isEngineConnectionLoss(new EngineUnavailableError("fetch caduto")), true);
  const otherCodes = [
    denied(),
    revoked(),
    homunErrorFromHttp(404, { detail: { code: "not_found", message: "no" } }, "nf"),
    homunErrorFromHttp(503, { detail: { code: "provider_unavailable", message: "no" } }, "pu"),
    new HomunClientError("request_timeout", "timeout"),
    new HomunClientError("storage_unavailable", "storage"),
    new HomunClientError("version_conflict", "conflict"),
    new HomunClientError("validation_error", "invalid"),
    new HomunClientError("unknown", "raw [Errno 61]"),
    new Error("[Errno 61] Connection refused"),
    null,
    undefined,
  ];
  for (const cause of otherCodes) {
    assert.equal(
      isEngineConnectionLoss(cause),
      false,
      `non è una caduta di connessione: ${String(cause)}`,
    );
  }
});
