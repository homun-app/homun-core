import { AlertCircle, Loader2 } from "lucide-react";

/** QR slot shared by the pairing tabs: loader, rendered QR, or unavailable notice. */
export function ChannelQrBox({
  loading,
  qrDataUrl,
  loadingText,
  alt,
  errorText,
}: {
  loading: boolean;
  qrDataUrl: string | null;
  loadingText: string;
  alt: string;
  errorText: string;
}) {
  return (
    <div className="msg-modal-qr-box">
      {loading ? (
        <div className="msg-modal-qr-loading">
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{loadingText}</span>
        </div>
      ) : qrDataUrl ? (
        <img src={qrDataUrl} alt={alt} className="msg-modal-qr-img" />
      ) : (
        <div className="msg-modal-qr-loading">
          <AlertCircle size={28} className="text-destructive" />
          <span className="text-xs text-destructive">{errorText}</span>
        </div>
      )}
    </div>
  );
}
