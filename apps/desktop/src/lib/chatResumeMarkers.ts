export interface ResumeMarker {
  requestId: string;
  userText: string;
  assistantMessageId: string;
  ownerId?: string;
  createdAt?: number;
}

const RESUME_MARKER_TTL_MS = 5 * 60 * 1000;

function resumeMarkerKey(threadId: string) {
  return `lfpa.resume.${threadId}`;
}

export function writeResumeMarker(
  threadId: string,
  marker: ResumeMarker,
  ownerId: string,
) {
  try {
    window.localStorage.setItem(
      resumeMarkerKey(threadId),
      JSON.stringify({ ...marker, ownerId, createdAt: Date.now() }),
    );
  } catch {
    /* storage unavailable -> resume simply won't be offered */
  }
}

export function isOwnResumeMarker(marker: ResumeMarker, ownerId: string): boolean {
  return marker.ownerId === ownerId;
}

export function clearResumeMarker(threadId: string) {
  try {
    window.localStorage.removeItem(resumeMarkerKey(threadId));
  } catch {
    /* ignore */
  }
}

export function readResumeMarker(threadId: string): ResumeMarker | null {
  try {
    const raw = window.localStorage.getItem(resumeMarkerKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeMarker;
    if (!parsed.createdAt || Date.now() - parsed.createdAt > RESUME_MARKER_TTL_MS) {
      clearResumeMarker(threadId);
      return null;
    }
    if (parsed && parsed.requestId && parsed.assistantMessageId) return parsed;
  } catch {
    /* ignore malformed */
  }
  return null;
}
