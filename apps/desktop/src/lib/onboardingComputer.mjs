const ROW_IDS = ["docker", "image", "container", "browser"];

const ACTIVE_ROW_BY_PHASE = {
  checking_docker: 0,
  preparing_image: 1,
  starting_container: 2,
  verifying_browser: 3,
};

export function computerProgressRows(phase, failedAt = null) {
  if (phase === "ready") {
    return ROW_IDS.map((id) => ({ id, state: "done" }));
  }
  if (phase === "failed") {
    const failedIndex = ACTIVE_ROW_BY_PHASE[failedAt ?? "checking_docker"] ?? 0;
    return ROW_IDS.map((id, index) => ({
      id,
      state: index < failedIndex ? "done" : index === failedIndex ? "error" : "pending",
    }));
  }
  const activeIndex = ACTIVE_ROW_BY_PHASE[phase];
  return ROW_IDS.map((id, index) => ({
    id,
    state:
      activeIndex == null
        ? "pending"
        : index < activeIndex
          ? "done"
          : index === activeIndex
            ? "active"
            : "pending",
  }));
}

export function canContinueFromComputer(status) {
  return status.phase === "ready" && status.ready === true;
}
