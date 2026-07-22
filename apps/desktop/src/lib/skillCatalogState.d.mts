export interface CatalogIdentityInput {
  slug: string;
  owner_handle?: string | null;
}

export interface InstalledSkillIdentity {
  id: string;
  source: string;
}

export type CatalogInstallState = "available" | "installed" | "occupied";

export function catalogIdentity(skill: CatalogIdentityInput): string;

export function catalogDisplayIdentity(skill: CatalogIdentityInput): string;

export function catalogInstallState(
  skill: CatalogIdentityInput,
  installedSkills: InstalledSkillIdentity[],
): CatalogInstallState;
