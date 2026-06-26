import { Shield, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  coreBridge,
  type CoreContact,
  type ProjectAccessGrant,
  type WorkspaceRecord,
} from "../lib/coreBridge";

type ProjectAccessDialogProps = {
  workspace: WorkspaceRecord | null;
  onClose: () => void;
};

const CHANNELS = ["whatsapp", "telegram", "email"];
const CAPABILITY_DENY_OPTIONS = [
  { value: "browser", label: "Computer/browser" },
  { value: "filesystem", label: "Filesystem" },
  { value: "make_deck", label: "Presentations" },
  { value: "make_document", label: "Documents" },
  { value: "connector", label: "Connectors" },
];

export function ProjectAccessDialog({ workspace, onClose }: ProjectAccessDialogProps) {
  const [contacts, setContacts] = useState<CoreContact[]>([]);
  const [grants, setGrants] = useState<ProjectAccessGrant[]>([]);
  const [contactReference, setContactReference] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [canTriggerAutomations, setCanTriggerAutomations] = useState(true);
  const [canUseProjectMemory, setCanUseProjectMemory] = useState(true);
  const [canReceiveReplies, setCanReceiveReplies] = useState(true);
  const [canReceiveArtifacts, setCanReceiveArtifacts] = useState(false);
  const [selectedCapabilityDenies, setSelectedCapabilityDenies] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setError(null);
    void Promise.all([coreBridge.contacts(), coreBridge.projectAccess(workspace.id)])
      .then(([nextContacts, nextGrants]) => {
        const grantableContacts = nextContacts.filter((contact) => !contact.is_self);
        setContacts(nextContacts);
        setGrants(nextGrants);
        setContactReference((current) =>
          current && grantableContacts.some((contact) => contact.reference === current)
            ? current
            : grantableContacts[0]?.reference || "",
        );
      })
      .catch((err) => setError((err as Error).message));
  }, [workspace]);

  const selfContact = useMemo(
    () => contacts.find((contact) => contact.is_self),
    [contacts],
  );
  const grantableContacts = useMemo(
    () => contacts.filter((contact) => !contact.is_self),
    [contacts],
  );
  const selectedContact = useMemo(
    () => grantableContacts.find((contact) => contact.reference === contactReference),
    [grantableContacts, contactReference],
  );

  if (!workspace) return null;

  async function addGrant() {
    if (!workspace || !selectedContact) return;
    setSaving(true);
    setError(null);
    try {
      const next = await coreBridge.upsertProjectAccess(workspace.id, {
        contact_reference: selectedContact.reference,
        contact_name: selectedContact.name,
        channel,
        can_trigger_automations: canTriggerAutomations,
        can_use_project_memory: canUseProjectMemory,
        can_receive_replies: canReceiveReplies,
        can_receive_artifacts: canReceiveArtifacts,
        capability_denies: selectedCapabilityDenies,
      });
      setGrants(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function removeGrant(grant: ProjectAccessGrant) {
    if (!workspace) return;
    setSaving(true);
    setError(null);
    try {
      const next = await coreBridge.removeProjectAccess(
        workspace.id,
        grant.contact_reference,
        grant.channel,
      );
      setGrants(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggleSelectedCapabilityDeny(value: string, denied: boolean) {
    setSelectedCapabilityDenies((current) => {
      const next = denied ? [...current, value] : current.filter((item) => item !== value);
      return Array.from(new Set(next)).sort();
    });
  }

  async function updateGrantCapabilityDeny(
    grant: ProjectAccessGrant,
    capability: string,
    denied: boolean,
  ) {
    if (!workspace) return;
    setSaving(true);
    setError(null);
    const capability_denies = denied
      ? Array.from(new Set([...grant.capability_denies, capability])).sort()
      : grant.capability_denies.filter((item) => item !== capability);
    try {
      const next = await coreBridge.upsertProjectAccess(workspace.id, {
        contact_reference: grant.contact_reference,
        contact_name: grant.contact_name,
        channel: grant.channel,
        can_trigger_automations: grant.can_trigger_automations,
        can_use_project_memory: grant.can_use_project_memory,
        can_receive_replies: grant.can_receive_replies,
        can_receive_artifacts: grant.can_receive_artifacts,
        capability_denies,
      });
      setGrants(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="project-access-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="project-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Project access for ${workspace.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-access-header">
          <div>
            <p className="eyebrow">Project access</p>
            <h2>{workspace.name}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="project-access-add">
          <select
            value={contactReference}
            onChange={(event) => setContactReference(event.target.value)}
          >
            {grantableContacts.length === 0 ? (
              <option value="">No contacts to authorize</option>
            ) : null}
            {grantableContacts.map((contact) => (
              <option key={contact.reference} value={contact.reference}>
                {contact.name}
              </option>
            ))}
          </select>
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            {CHANNELS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            className="primary-button"
            type="button"
            disabled={!selectedContact || saving}
            onClick={() => void addGrant()}
          >
            <UserPlus size={15} />
            Authorize
          </button>
        </div>

        <div className="project-access-permissions" aria-label="Project access permissions">
          <label>
            <input
              type="checkbox"
              checked={canTriggerAutomations}
              onChange={(event) => setCanTriggerAutomations(event.target.checked)}
            />
            <span>Can trigger automations</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={canUseProjectMemory}
              onChange={(event) => setCanUseProjectMemory(event.target.checked)}
            />
            <span>Can use project memory</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={canReceiveReplies}
              onChange={(event) => setCanReceiveReplies(event.target.checked)}
            />
            <span>Can receive replies</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={canReceiveArtifacts}
              onChange={(event) => setCanReceiveArtifacts(event.target.checked)}
            />
            <span>Can receive artifacts</span>
          </label>
        </div>

        <fieldset className="project-access-denies" aria-label="Denied capabilities">
          <legend>Denied capabilities</legend>
          <p>
            Optional: narrow this project grant further. Denials compose with the
            contact perimeter and denial wins.
          </p>
          <div>
            {CAPABILITY_DENY_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  checked={selectedCapabilityDenies.includes(option.value)}
                  onChange={(event) =>
                    toggleSelectedCapabilityDeny(option.value, event.target.checked)
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {error ? <p className="project-access-error">{error}</p> : null}

        <div className="project-access-list">
          {selfContact ? (
            <article className="project-access-row is-self">
              <Shield size={16} />
              <div className="project-access-contact">
                <strong>{selfContact.name || "You"}</strong>
                <span>Owner</span>
              </div>
              <div className="project-access-flags">
                <span>All channels</span>
                <span>Full project access</span>
                <span>No grant required</span>
              </div>
            </article>
          ) : null}
          {grants.length === 0 ? (
            <p className="drawer-empty">No contacts are authorized for this project yet.</p>
          ) : (
            grants.map((grant) => (
              <article
                className="project-access-row"
                key={`${grant.contact_reference}:${grant.channel}`}
              >
                <Shield size={16} />
                <div className="project-access-contact">
                  <strong>{grant.contact_name || grant.contact_reference}</strong>
                  <span>{grant.channel}</span>
                </div>
                <div className="project-access-flags">
                  {grant.can_trigger_automations ? <span>Automations</span> : null}
                  {grant.can_use_project_memory ? <span>Project memory</span> : null}
                  {grant.can_receive_replies ? <span>Replies</span> : null}
                  {grant.can_receive_artifacts ? <span>Artifacts</span> : null}
                  {grant.capability_denies.map((deny) => (
                    <span key={deny}>Deny {deny}</span>
                  ))}
                </div>
                <div className="project-access-row-denies" aria-label="Edit denied capabilities">
                  {CAPABILITY_DENY_OPTIONS.map((option) => (
                    <label key={option.value}>
                      <input
                        type="checkbox"
                        checked={grant.capability_denies.includes(option.value)}
                        disabled={saving}
                        onChange={(event) =>
                          void updateGrantCapabilityDeny(grant, option.value, event.target.checked)
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
                <button
                  className="icon-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void removeGrant(grant)}
                  aria-label="Remove access"
                >
                  <Trash2 size={15} />
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
