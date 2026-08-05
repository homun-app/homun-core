import type { KeyboardEvent } from "react";

interface MessageEditBoxProps {
  value: string;
  cancelLabel: string;
  saveLabel: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

export function MessageEditBox({
  value,
  cancelLabel,
  saveLabel,
  onChange,
  onCancel,
  onSave,
}: MessageEditBoxProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div className="message-edit">
      <textarea
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="message-edit-actions">
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="primary" disabled={!value.trim()} onClick={onSave}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
