import { useEffect, useState } from "react";
function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const isText =
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json|log|py|rs|tsx?|jsx?|css|html|ya?ml|xml|sh)$/i.test(file.name);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    let active = true;
    if (isText)
      file
        .slice(0, 200000)
        .text()
        .then((value) => {
          if (active) setText(value);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, isText]);
  return (
    <div className="st-artifact-preview">
      {isText && !failed ? (
        <>
          <pre>{text}</pre>
          {file.size > 200000 && (
            <p>Anteprima limitata ai primi 200 KB. Scarica il file completo.</p>
          )}
        </>
      ) : /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) && !failed ? (
        <img src={url} alt={file.name} onError={() => setFailed(true)} />
      ) : (
        <p>
          {file.type === "application/pdf"
            ? "Apri il PDF nel visualizzatore del browser."
            : "Scarica questo formato per verificarlo nella tua applicazione."}
        </p>
      )}
      {file.type === "application/pdf" && (
        <a className="st-btn" href={url} target="_blank" rel="noreferrer">
          Apri PDF
        </a>
      )}
      <a className="st-btn" href={url} download={file.name}>
        Scarica originale
      </a>
    </div>
  );
}
function Artifact({ file, label }: { file: File; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {label} · {file.webkitRelativePath || file.name}{" "}
        <small> · {Math.max(1, Math.round(file.size / 1024))} KB</small>
      </summary>
      {open && <Preview file={file} />}
    </details>
  );
}
export function StudioArtifactPreview({
  files,
  label = "File",
}: {
  files: File[];
  label?: string;
}) {
  return (
    <div className="st-artifacts">
      {files.map((file, index) => (
        <Artifact key={file.name + file.lastModified + index} file={file} label={label} />
      ))}
    </div>
  );
}
