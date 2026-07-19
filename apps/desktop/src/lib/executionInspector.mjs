export function selectLatestRun(runs) {
  return [...runs].sort((a, b) => b.started_at - a.started_at || b.attempt - a.attempt)[0] ?? null;
}

export function packetLabel(packet) {
  return `${packet.source}:${packet.id}`;
}
