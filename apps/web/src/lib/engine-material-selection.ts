/**
 * Pure selection helpers for project materials as tool sources (Fonte=motore).
 * The engine is authoritative for availability; these only filter what the
 * cards offer and format the reference the person sees.
 */
import type { EngineMaterial } from "./engine-projects-client.ts";

const READABLE_EXTENSIONS = [".txt", ".md", ".csv", ".tsv", ".json", ".log", ".pdf"];

/** What each tool can use — also hints the single-file picker via `accept`. */
export const READ_UPLOAD_EXTENSIONS: readonly string[] = READABLE_EXTENSIONS;
export const COMPARISON_UPLOAD_EXTENSIONS: readonly string[] = [".csv"];

function hasExtension(name: string | null | undefined, extensions: readonly string[]): boolean {
  const lower = (name ?? "").toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function isManagedFile(material: EngineMaterial): boolean {
  return Boolean(material.storage_relpath) && Boolean(material.content_hash);
}

export function eligibleForRead(material: EngineMaterial): boolean {
  return (
    material.status === "active" &&
    isManagedFile(material) &&
    (material.byte_size ?? 0) > 0 &&
    (material.byte_size ?? 0) <= 2 * 1024 * 1024 &&
    material.extract_status !== "unsupported" &&
    material.extract_status !== "failed" &&
    hasExtension(material.origin_name ?? material.title, READABLE_EXTENSIONS)
  );
}

export function eligibleForComparison(material: EngineMaterial): boolean {
  return (
    material.status === "active" &&
    isManagedFile(material) &&
    (material.byte_size ?? 0) > 0 &&
    (material.byte_size ?? 0) <= 2 * 1024 * 1024 &&
    hasExtension(material.origin_name ?? material.title, [".csv"])
  );
}

/** Files a preparation-phase work can collect before an executable agreement. */
export function eligibleForPreparation(material: EngineMaterial): boolean {
  return (
    material.status === "active" &&
    isManagedFile(material) &&
    (material.byte_size ?? 0) > 0 &&
    (material.byte_size ?? 0) <= 2 * 1024 * 1024 &&
    hasExtension(material.origin_name ?? material.title, READABLE_EXTENSIONS)
  );
}

export function materialOptionLabel(material: EngineMaterial): string {
  const name = material.origin_name ?? material.title;
  const size = material.byte_size != null ? `${material.byte_size} B` : "dimensione n/d";
  return `${name} · v${material.version} · ${size}`;
}
