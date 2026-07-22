import * as implementation from "./skillCatalogState.mjs";

export interface CatalogIdentityInput {
  slug: string;
  owner_handle?: string | null;
}

export interface InstalledSkillIdentity {
  id: string;
  source: string;
}

export type CatalogInstallState = "available" | "installed" | "occupied";

export const catalogIdentity: (skill: CatalogIdentityInput) => string =
  implementation.catalogIdentity;

export const catalogDisplayIdentity: (skill: CatalogIdentityInput) => string =
  implementation.catalogDisplayIdentity;

export const catalogInstallState: (
  skill: CatalogIdentityInput,
  installed: InstalledSkillIdentity[],
) => CatalogInstallState = implementation.catalogInstallState;
