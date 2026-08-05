import { Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "../types";

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageAttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  const { t } = useTranslation();
  return (
    <div className="message-attachment-list" aria-label={t("chat.messageAttachments")}>
      {attachments.map((attachment) =>
        attachment.kind === "image" && attachment.previewUrl ? (
          <img
            className="message-image-attachment"
            key={attachment.artifactId}
            src={attachment.previewUrl}
            alt={attachment.title}
          />
        ) : (
          <span className="message-attachment-chip" key={attachment.artifactId}>
            <Paperclip size={13} />
            <span>{attachment.title}</span>
            <small>
              {attachment.kind} &middot; {formatFileSize(attachment.sizeBytes)}
            </small>
          </span>
        ),
      )}
    </div>
  );
}
