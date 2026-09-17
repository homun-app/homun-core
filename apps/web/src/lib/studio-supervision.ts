export type AutonomyMode = "stage" | "review" | "autonomous";
type Member = { id: string; autonomy?: AutonomyMode };
type Team = { members: string[]; leader?: string };
// Use a team default only when all applicable teams agree; never infer from list order.
export function teamSupervision(
  person: string,
  teams: Team[],
  members: Member[],
  fallback: string,
) {
  const relevant = teams.filter((t) => t.members.includes(person));
  const candidates = relevant.map((t) =>
    t.leader &&
    t.members.includes(t.leader) &&
    t.leader !== person &&
    members.some((m) => m.id === t.leader)
      ? t.leader
      : fallback,
  );
  const supervisor =
    candidates.length && new Set(candidates).size === 1 ? candidates[0]! : fallback;
  // Agent coordinators can do an initial check. Final approval stays human in this prototype.
  return { supervisor, approver: supervisor.startsWith("user:") ? supervisor : fallback };
}
