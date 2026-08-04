/**
 * Projects a persisted artifact catalog row onto the single preview contract.
 * Managed artifacts are addressed by thread + name; project files retain their
 * explicit path and remain subject to the filesystem authorization jail.
 */
export function projectMemoryArtifact(artifact, currentThread) {
  const managed =
    artifact.managed_path &&
    artifact.thread &&
    (artifact.storage === "managed" || artifact.storage == null);
  if (managed) {
    return {
      name: artifact.name,
      thread: artifact.thread,
      size: artifact.size,
      updated: artifact.updated,
      source: "managed",
      managed_path: artifact.managed_path,
    };
  }

  const displayName = artifact.project_relative_path || artifact.name;
  return {
    name: displayName,
    thread: artifact.thread || currentThread,
    size: artifact.size,
    updated: artifact.updated,
    source: "project",
    projectPath: artifact.project_path || undefined,
    projectRelativePath: artifact.project_relative_path || displayName,
  };
}
