export function createStreamSequenceGate(maxEntries = 512) {
  const cursors = new Map();

  return {
    accept(event) {
      const sequence = Number(event?.seq);
      if (!Number.isFinite(sequence)) return true;
      const requestId = String(event?.request_id ?? "");
      const previous = cursors.get(requestId);
      if (previous !== undefined && sequence <= previous) return false;
      cursors.delete(requestId);
      cursors.set(requestId, sequence);
      while (cursors.size > maxEntries) {
        const oldest = cursors.keys().next().value;
        if (oldest === undefined) break;
        cursors.delete(oldest);
      }
      return true;
    },
    clear(requestId) {
      cursors.delete(requestId);
    },
    size() {
      return cursors.size;
    },
  };
}
