/**
 * Settings → Progetti: engine Project + Team + AccessGrant + Materials (B1–B3).
 */

import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import { listEngineAgents, type EngineAgentProfile } from "@/lib/engine-agents-client";
import {
  archiveEngineMaterial,
  createEngineMaterial,
  createEngineProject,
  createEngineTeam,
  getEngineMaterialContent,
  ingestEngineMaterial,
  issueEngineGrant,
  listEngineGrants,
  listEngineMaterials,
  listEngineProjects,
  listEngineTeams,
  revokeEngineGrant,
  updateEngineProject,
  updateEngineTeam,
  type EngineGrant,
  type EngineMaterial,
  type EngineProject,
  type EngineTeam,
  type GrantCapability,
  type MaterialKind,
} from "@/lib/engine-projects-client";

type Props = {
  actorId?: string;
};

export function ConversationProjectsSettingsSection({ actorId = "person_fabio" }: Props) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.domain;
  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [teams, setTeams] = useState<EngineTeam[]>([]);
  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [grants, setGrants] = useState<EngineGrant[]>([]);
  const [materials, setMaterials] = useState<EngineMaterial[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectTeamIds, setProjectTeamIds] = useState<string[]>([]);
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([actorId]);
  const [coordinatorId, setCoordinatorId] = useState(actorId);
  const [grantSubjectId, setGrantSubjectId] = useState(actorId);
  const [grantCapability, setGrantCapability] = useState<GrantCapability>("read");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialKind, setMaterialKind] = useState<MaterialKind>("note");
  const [materialText, setMaterialText] = useState("");
  const [materialUri, setMaterialUri] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;
  const actor = { id: actorId, displayName: actorId === "person_fabio" ? "Fabio" : actorId };

  async function refresh() {
    const [p, t, a] = await Promise.all([
      listEngineProjects(undefined, undefined, actor),
      listEngineTeams(),
      listEngineAgents().catch(() => [] as EngineAgentProfile[]),
    ]);
    setProjects(p);
    setTeams(t);
    setAgents(a);
  }

  async function refreshProjectExtras(projectId: string) {
    const [g, m] = await Promise.all([
      listEngineGrants({ projectId, actor }),
      listEngineMaterials({ projectId, actor }).catch(() => [] as EngineMaterial[]),
    ]);
    setGrants(g);
    setMaterials(m);
  }

  useEffect(() => {
    if (!engineReady) {
      setProjects([]);
      setTeams([]);
      setGrants([]);
      setMaterials([]);
      return;
    }
    void refresh().catch((cause: unknown) => setError(cause));
  }, [engineReady, status.connection]);

  useEffect(() => {
    if (!selectedProject) {
      setGrants([]);
      setMaterials([]);
      return;
    }
    setProjectName(selectedProject.name);
    setProjectDescription(selectedProject.description ?? "");
    setProjectTeamIds([...selectedProject.team_ids]);
    void refreshProjectExtras(selectedProject.id).catch((cause: unknown) => setError(cause));
  }, [selectedProjectId, selectedProject?.version]);

  useEffect(() => {
    if (!selectedTeam) return;
    setTeamName(selectedTeam.name);
    setTeamDescription(selectedTeam.description ?? "");
    setTeamMemberIds([...selectedTeam.member_ids]);
    setCoordinatorId(selectedTeam.coordinator_id ?? actorId);
  }, [selectedTeamId, selectedTeam?.revision]);

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  if (status.connection !== "connected") {
    return (
      <>
        <h3>Progetti</h3>
        <p>
          Avvia il motore (<code>npm run engine:dev</code>) per gestire progetti e team. Nessun
          fallback in simulazione.
        </p>
      </>
    );
  }

  if (!engineReady) {
    return (
      <>
        <h3>Progetti</h3>
        <p>Il motore è connesso ma la capability <code>domain</code> non è disponibile.</p>
      </>
    );
  }

  const memberChoices = [
    { id: actorId, label: `Tu (${actorId})` },
    ...agents.map((a) => ({ id: a.id, label: `${a.name} (${a.id})` })),
  ];

  return (
    <>
      <h3>Progetti e team</h3>
      <p>
        Organizzazione Homun sul motore. Appartenenza a un team/progetto non concede AccessGrant.
        Lettura/scrittura progetti richiedono grant espliciti (deny-by-default).
      </p>

      <div className="cv-settings-card">
        <strong>Team</strong>
        {!teams.length ? (
          <p>Nessun team.</p>
        ) : (
          <ul className="cv-settings-memory-list">
            {teams.map((team) => (
              <li key={team.id}>
                <button
                  type="button"
                  className={selectedTeamId === team.id ? "cw-primary" : "cw-secondary"}
                  disabled={busy}
                  onClick={() => setSelectedTeamId(team.id)}
                >
                  {team.name} · {team.status}
                </button>
                <small>
                  <code>{team.id}</code>
                </small>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="cw-secondary"
          disabled={busy}
          onClick={() => {
            setSelectedTeamId(null);
            setTeamName("");
            setTeamDescription("");
            setTeamMemberIds([actorId]);
            setCoordinatorId(actorId);
          }}
        >
          Nuovo team
        </button>
        <label>
          Nome team
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} aria-label="Nome team" />
        </label>
        <label>
          Descrizione
          <textarea
            value={teamDescription}
            onChange={(e) => setTeamDescription(e.target.value)}
            rows={2}
            aria-label="Descrizione team"
          />
        </label>
        <fieldset>
          <legend>Membri</legend>
          {memberChoices.map((m) => (
            <label key={m.id} className="cv-settings-toggle">
              <span>{m.label}</span>
              <input
                type="checkbox"
                checked={teamMemberIds.includes(m.id)}
                onChange={() => setTeamMemberIds((prev) => toggleId(prev, m.id))}
              />
            </label>
          ))}
        </fieldset>
        <label>
          Coordinatore
          <select
            value={coordinatorId}
            onChange={(e) => setCoordinatorId(e.target.value)}
            aria-label="Coordinatore team"
          >
            <option value="">Nessuno</option>
            {teamMemberIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="cw-primary"
          disabled={busy || !teamName.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            setInfo(null);
            const task = selectedTeam
              ? updateEngineTeam({
                  teamId: selectedTeam.id,
                  expectedVersion: selectedTeam.revision,
                  name: teamName.trim(),
                  description: teamDescription,
                  memberIds: teamMemberIds,
                  coordinatorId: coordinatorId || null,
                  actor,
                }).then(async () => {
                  setInfo("Team aggiornato");
                  await refresh();
                })
              : createEngineTeam({
                  name: teamName.trim(),
                  description: teamDescription,
                  memberIds: teamMemberIds,
                  coordinatorId: coordinatorId || null,
                  actor,
                }).then(async (created) => {
                  setInfo(`Team creato · ${created.teamId}`);
                  setSelectedTeamId(created.teamId);
                  await refresh();
                });
            void task.catch((cause: unknown) => setError(cause)).finally(() => setBusy(false));
          }}
        >
          {selectedTeam ? "Salva team" : "Crea team"}
        </button>
      </div>

      <div className="cv-settings-card">
        <strong>Progetti</strong>
        {!projects.length ? (
          <p>Nessun progetto (o nessun grant di lettura).</p>
        ) : (
          <ul className="cv-settings-memory-list">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className={selectedProjectId === project.id ? "cw-primary" : "cw-secondary"}
                  disabled={busy}
                  onClick={() => setSelectedProjectId(project.id)}
                >
                  {project.name} · {project.status}
                </button>
                <small>
                  <code>{project.id}</code>
                </small>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="cw-secondary"
          disabled={busy}
          onClick={() => {
            setSelectedProjectId(null);
            setProjectName("");
            setProjectDescription("");
            setProjectTeamIds([]);
            setGrants([]);
            setMaterials([]);
          }}
        >
          Nuovo progetto
        </button>
        <label>
          Nome progetto
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Nome progetto"
          />
        </label>
        <label>
          Descrizione
          <textarea
            value={projectDescription}
            onChange={(e) => setProjectDescription(e.target.value)}
            rows={2}
            aria-label="Descrizione progetto"
          />
        </label>
        <fieldset>
          <legend>Team collegati</legend>
          {!teams.length ? (
            <p>Crea prima un team.</p>
          ) : (
            teams.map((team) => (
              <label key={team.id} className="cv-settings-toggle">
                <span>
                  {team.name} <code>{team.id}</code>
                </span>
                <input
                  type="checkbox"
                  checked={projectTeamIds.includes(team.id)}
                  onChange={() => setProjectTeamIds((prev) => toggleId(prev, team.id))}
                />
              </label>
            ))
          )}
        </fieldset>
        <button
          type="button"
          className="cw-primary"
          disabled={busy || !projectName.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            setInfo(null);
            const task = selectedProject
              ? updateEngineProject({
                  projectId: selectedProject.id,
                  expectedVersion: selectedProject.version,
                  name: projectName.trim(),
                  description: projectDescription,
                  teamIds: projectTeamIds,
                  memberIds: [actorId],
                  actor,
                }).then(async () => {
                  setInfo("Progetto aggiornato");
                  await refresh();
                })
              : createEngineProject({
                  name: projectName.trim(),
                  description: projectDescription,
                  teamIds: projectTeamIds,
                  memberIds: [actorId],
                  actor,
                }).then(async (created) => {
                  setInfo(`Progetto creato · ${created.projectId}`);
                  setSelectedProjectId(created.projectId);
                  await refresh();
                });
            void task.catch((cause: unknown) => setError(cause)).finally(() => setBusy(false));
          }}
        >
          {selectedProject ? "Salva progetto" : "Crea progetto"}
        </button>
      </div>

      {selectedProject ? (
        <div className="cv-settings-card">
          <strong>AccessGrant · {selectedProject.name}</strong>
          <p>Concede read / write / admin. La membership non basta.</p>
          {!grants.length ? (
            <p>Nessun grant visibile.</p>
          ) : (
            <ul className="cv-settings-memory-list">
              {grants.map((grant) => (
                <li key={grant.id}>
                  <span>
                    {grant.subject_id} · {grant.capability} · {grant.status}
                  </span>
                  {grant.status === "active" ? (
                    <button
                      type="button"
                      className="cw-secondary"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        void revokeEngineGrant({ grantId: grant.id, actor })
                          .then(async () => {
                            setInfo("Grant revocato");
                            await refreshProjectExtras(selectedProject.id);
                          })
                          .catch((cause: unknown) => setError(cause))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Revoca
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <label>
            Soggetto
            <select
              value={grantSubjectId}
              onChange={(e) => setGrantSubjectId(e.target.value)}
              aria-label="Soggetto grant"
            >
              {memberChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Capacità
            <select
              value={grantCapability}
              onChange={(e) => setGrantCapability(e.target.value as GrantCapability)}
              aria-label="Capacità grant"
            >
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button
            type="button"
            className="cw-primary"
            disabled={busy || !grantSubjectId}
            onClick={() => {
              setBusy(true);
              setError(null);
              void issueEngineGrant({
                projectId: selectedProject.id,
                subjectId: grantSubjectId,
                capability: grantCapability,
                actor,
              })
                .then(async (issued) => {
                  setInfo(`Grant emesso · ${issued.grantId}`);
                  await refreshProjectExtras(selectedProject.id);
                })
                .catch((cause: unknown) => setError(cause))
                .finally(() => setBusy(false));
            }}
          >
            Emitti grant
          </button>
        </div>
      ) : null}

      {selectedProject ? (
        <div className="cv-settings-card">
          <strong>Materiali · {selectedProject.name}</strong>
          <p>
            Ingest locale (F4.2): copia in archivio motore, hash, extract TXT/CSV/PDF testo. OCR
            escluso. Cartelle = flatten one-shot.
          </p>
          <div className="cs-actions">
            <label className="cw-secondary" style={{ display: "inline-block", cursor: "pointer" }}>
              Carica file
              <input
                type="file"
                hidden
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || !selectedProject) return;
                  setBusy(true);
                  setError(null);
                  void ingestEngineMaterial({
                    projectId: selectedProject.id,
                    file,
                    actor,
                  })
                    .then(async (ingested) => {
                      setInfo(
                        `Ingestito ${ingested.title} · extract=${ingested.extractStatus}`,
                      );
                      await refreshProjectExtras(selectedProject.id);
                    })
                    .catch((cause: unknown) => setError(cause))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
            <label className="cw-secondary" style={{ display: "inline-block", cursor: "pointer" }}>
              Carica cartella
              <input
                type="file"
                hidden
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                disabled={busy}
                onChange={(e) => {
                  const list = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  if (!list.length || !selectedProject) return;
                  setBusy(true);
                  setError(null);
                  void (async () => {
                    try {
                      for (const file of list) {
                        const relativePath = file.webkitRelativePath || file.name;
                        await ingestEngineMaterial({
                          projectId: selectedProject.id,
                          file,
                          relativePath,
                          actor,
                        });
                      }
                      setInfo(`Cartella importata · ${list.length} file`);
                      await refreshProjectExtras(selectedProject.id);
                    } catch (cause: unknown) {
                      setError(cause);
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              />
            </label>
          </div>
          {!materials.length ? (
            <p>Nessun materiale attivo.</p>
          ) : (
            <ul className="cv-settings-memory-list">
              {materials.map((material) => (
                <li key={material.id}>
                  <span>
                    {material.title} · {material.kind}
                    {material.extract_status
                      ? ` · ${material.extract_status}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="cw-secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError(null);
                      void getEngineMaterialContent({ materialId: material.id, actor })
                        .then((content) => {
                          setPreviewId(material.id);
                          setPreviewText(
                            content.extractStatus === "unsupported"
                              ? "(nessun testo estratto — formato non supportato / non dichiarato letto)"
                              : content.text || "(vuoto)",
                          );
                        })
                        .catch((cause: unknown) => setError(cause))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Anteprima
                  </button>
                  <button
                    type="button"
                    className="cw-secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError(null);
                      void archiveEngineMaterial({
                        materialId: material.id,
                        expectedVersion: material.version,
                        actor,
                      })
                        .then(async () => {
                          setInfo("Materiale archiviato");
                          if (previewId === material.id) {
                            setPreviewId(null);
                            setPreviewText(null);
                          }
                          await refreshProjectExtras(selectedProject.id);
                        })
                        .catch((cause: unknown) => setError(cause))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Archivia
                  </button>
                </li>
              ))}
            </ul>
          )}
          {previewId && previewText != null ? (
            <pre className="cv-settings-memory-preview" style={{ whiteSpace: "pre-wrap" }}>
              {previewText}
            </pre>
          ) : null}
          <label>
            Titolo
            <input
              value={materialTitle}
              onChange={(e) => setMaterialTitle(e.target.value)}
              aria-label="Titolo materiale"
            />
          </label>
          <label>
            Tipo
            <select
              value={materialKind}
              onChange={(e) => setMaterialKind(e.target.value as MaterialKind)}
              aria-label="Tipo materiale"
            >
              <option value="note">note</option>
              <option value="link">link</option>
              <option value="file_ref">file_ref</option>
            </select>
          </label>
          {materialKind === "note" ? (
            <label>
              Testo
              <textarea
                value={materialText}
                onChange={(e) => setMaterialText(e.target.value)}
                rows={2}
                aria-label="Testo materiale"
              />
            </label>
          ) : (
            <label>
              URI / path
              <input
                value={materialUri}
                onChange={(e) => setMaterialUri(e.target.value)}
                aria-label="URI materiale"
              />
            </label>
          )}
          <button
            type="button"
            className="cw-primary"
            disabled={busy || !materialTitle.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              void createEngineMaterial({
                projectId: selectedProject.id,
                title: materialTitle.trim(),
                kind: materialKind,
                text: materialKind === "note" ? materialText : "",
                sourceUri: materialKind === "note" ? null : materialUri.trim() || null,
                actor,
              })
                .then(async (created) => {
                  setInfo(`Materiale creato · ${created.materialId}`);
                  setMaterialTitle("");
                  setMaterialText("");
                  setMaterialUri("");
                  await refreshProjectExtras(selectedProject.id);
                })
                .catch((cause: unknown) => setError(cause))
                .finally(() => setBusy(false));
            }}
          >
            Aggiungi materiale
          </button>
        </div>
      ) : null}

      <HomunErrorNotice error={error} />
      {info ? <p className="cv-settings-note">{info}</p> : null}
    </>
  );
}
