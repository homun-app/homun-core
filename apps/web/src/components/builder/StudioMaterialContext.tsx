import { useContext } from "react";
import { StudioMaterialContext, type MaterialLink } from "../../lib/studio-material-context";
import { documentAccess } from "../../lib/studio-documents";
import { StudioProjectPicker } from "./StudioProjectPicker";
import { StudioArtifactPreview } from "./StudioArtifactPreview";
function useAvailableMaterials(owner: string) {
  const context = useContext(StudioMaterialContext);
  return context.documents.filter((d) => {
    const access = documentAccess(d, context.documents, context.projects, context.members);
    return access.includes(owner) && access.includes("user:fabio");
  });
}
export function StudioMaterialPicker({
  owner,
  value,
  onChange,
}: {
  owner: string;
  value: MaterialLink[];
  onChange: (value: MaterialLink[]) => void;
}) {
  const available = useAvailableMaterials(owner);
  return (
    <div>
      <StudioProjectPicker
        label="Dalla raccolta documenti"
        options={available.map((d) => ({
          id: d.id,
          name: (d.kind === "folder" ? "Cartella · " : "") + d.title,
        }))}
        value={value.map((v) => v.id)}
        emptyLabel="Collega file, note o cartelle esistenti"
        onChange={(ids) =>
          onChange(
            ids.flatMap((id) => {
              const doc = available.find((d) => d.id === id);
              return doc ? [{ id, version: doc.version, title: doc.title }] : [];
            }),
          )
        }
      />
      <p className="st-muted">
        Mostra i materiali accessibili a te e al responsabile, secondo i permessi della demo. Il
        collegamento usa la stessa risorsa della raccolta.
      </p>
    </div>
  );
}
export function StudioLinkedMaterials({ owner, links }: { owner: string; links: MaterialLink[] }) {
  const available = useAvailableMaterials(owner);
  return (
    <div>
      {links.map((link) => {
        const doc = available.find((d) => d.id === link.id);
        if (!doc)
          return (
            <p key={link.id}>Materiale collegato non disponibile · verifica accesso o rimozione.</p>
          );
        const children =
          doc.kind === "folder"
            ? available.filter((d) => {
                let parent = d.parentId;
                const seen = new Set<string>();
                while (parent && !seen.has(parent)) {
                  if (parent === doc.id) return true;
                  seen.add(parent);
                  parent = available.find((x) => x.id === parent)?.parentId;
                }
                return false;
              })
            : [doc];
        return (
          <details key={doc.id}>
            <summary>
              {doc.title} ·{" "}
              {doc.kind === "folder"
                ? children.length + " elementi accessibili"
                : "v" + doc.version}
              {doc.version !== link.version ? " · aggiornato dopo il collegamento" : ""}
            </summary>
            {children
              .filter((d) => d.body)
              .map((d) => (
                <div key={d.id}>
                  <strong>{d.title}</strong>
                  <p style={{ whiteSpace: "pre-wrap" }}>{d.body}</p>
                </div>
              ))}
            <StudioArtifactPreview
              files={children.flatMap((d) => (d.file ? [d.file] : []))}
              label="Raccolta"
            />
            {doc.kind === "folder" && (
              <p className="st-muted">
                Contenuto attuale della cartella, filtrato per accesso. I nuovi file della raccolta
                appariranno qui.
              </p>
            )}
          </details>
        );
      })}
    </div>
  );
}
