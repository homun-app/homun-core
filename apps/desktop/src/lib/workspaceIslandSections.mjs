const ACTIVE_EXECUTION_STATUSES = new Set([
  "queued",
  "running",
  "working",
  "waiting",
  "waiting_user",
  "approval_required",
  "paused",
]);

const FAILED_EXECUTION_STATUSES = new Set(["failed", "error"]);
const WAITING_EXECUTION_STATUSES = new Set([
  "waiting",
  "waiting_user",
  "approval_required",
  "paused",
]);

function normalizedStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function activityStatus(input) {
  const executionStatus = normalizedStatus(input.executionStatus);
  if (FAILED_EXECUTION_STATUSES.has(executionStatus)) return "failed";
  if (WAITING_EXECUTION_STATUSES.has(executionStatus)) return "waiting";
  if (
    input.streaming === true
    || ACTIVE_EXECUTION_STATUSES.has(executionStatus)
    || input.planSteps?.some((step) => normalizedStatus(step?.status) === "doing")
  ) {
    return "running";
  }
  return "idle";
}

export function nextWorkspaceSection(activeSection, requestedSection) {
  if (requestedSection === "browser") return null;
  return activeSection === requestedSection ? null : requestedSection;
}

export function workspaceSectionSelection(activeSection, requestedSection) {
  return {
    activeSection: nextWorkspaceSection(activeSection, requestedSection),
    browserDockRequested: requestedSection === "browser",
  };
}

export function projectWorkspaceSections(input = {}) {
  const sections = [];
  const planSteps = Array.isArray(input.planSteps) ? input.planSteps : [];
  const activity = Array.isArray(input.activity) ? input.activity : [];
  const executionStatus = normalizedStatus(input.executionStatus);
  const hasActivity =
    planSteps.length > 0
    || activity.length > 0
    || input.streaming === true
    || ACTIVE_EXECUTION_STATUSES.has(executionStatus)
    || FAILED_EXECUTION_STATUSES.has(executionStatus);

  if (hasActivity) {
    sections.push({
      id: "activity",
      status: activityStatus({ ...input, planSteps }),
      badge: null,
      labelKey: "chat.workspaceIsland.activity",
    });
  }

  const browser = input.browser;
  if (browser?.active === true || browser?.snapshotVerified === true) {
    sections.push({
      id: "browser",
      status: browser.failed === true ? "failed" : browser.active === true ? "running" : "idle",
      badge: null,
      labelKey: "chat.workspaceIsland.browser",
    });
  }

  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  if (artifacts.length > 0) {
    sections.push({
      id: "artifacts",
      status: "idle",
      badge: artifacts.length,
      labelKey: "chat.workspaceIsland.artifacts",
    });
  }

  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (sources.length > 0) {
    sections.push({
      id: "sources",
      status: "idle",
      badge: sources.length,
      labelKey: "chat.workspaceIsland.sources",
    });
  }

  return sections;
}
