/** Stable remote identity: ClawHub permits duplicate slugs across publishers. */
export function catalogIdentity(skill) {
  return skill.owner_handle ? `${skill.owner_handle}/${skill.slug}` : skill.slug;
}

/** User-visible identity mirrors the exact publisher-qualified install target. */
export function catalogDisplayIdentity(skill) {
  return skill.owner_handle ? `@${skill.owner_handle}/${skill.slug}` : skill.slug;
}

/** Local IDs remain slug-based, so provenance separates exact installs from collisions. */
export function catalogInstallState(skill, installedSkills) {
  const installed = installedSkills.find((candidate) => candidate.id === skill.slug);
  if (!installed) return "available";
  const expected = skill.owner_handle
    ? `clawhub:@${skill.owner_handle}/${skill.slug}`
    : `clawhub:${skill.slug}`;
  return installed.source === expected ? "installed" : "occupied";
}
