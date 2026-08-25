import type { AutomationProposal, BrainRunDetail, LearningInsight } from "../types";

export const brainRun: BrainRunDetail = {
  requestId: "req_acme_morning",
  route: "mixed_workflow",
  status: "running",
  plannerRounds: 2,
  loadedTools: 5,
  memoryRefs: ["memory:user:workspace:acme", "memory:user:workspace:routine"],
  contextBudget: [
    {
      label: "memory_context",
      compressed: true,
      redacted: true,
      inputChars: 8420,
      outputChars: 1870,
      estimatedInputTokens: 2105,
      estimatedOutputTokens: 468,
      compressionRatio: 0.22,
      redactionCount: 2,
    },
    {
      label: "loaded_tool_details",
      compressed: true,
      redacted: false,
      inputChars: 5340,
      outputChars: 2980,
      estimatedInputTokens: 1335,
      estimatedOutputTokens: 745,
      compressionRatio: 0.56,
      redactionCount: 0,
    },
  ],
  steps: [
    {
      id: "context",
      label: "Load memory context",
      status: "done",
      detail: "2 redacted references",
    },
    {
      id: "tasks",
      label: "Read tasks and messages",
      status: "running",
      detail: "Immediate read-only tool",
    },
    {
      id: "review",
      label: "ReviewAgent",
      status: "queued",
      detail: "Durable subagent task",
    },
  ],
};

export const learningInsights: LearningInsight[] = [
  {
    id: "morning_project_start",
    title: "Often starts from the active project",
    summary:
      "When you start a work session you first ask for git status, open tasks and the next useful action.",
    domain: "work",
    cadence: "Morning, weekdays",
    confidence: 0.84,
    status: "confirmed",
    evidence: [
      "6 local sessions with project opening and task check",
      "3 consecutive requests prioritized status, plan and verification",
      "No raw data saved: only metadata and redacted references",
    ],
  },
  {
    id: "travel_compare_before_booking",
    title: "Want comparison before purchasing",
    summary:
      "On travel searches you prefer seeing options, sources and tradeoffs before login, payment or booking.",
    domain: "personal",
    cadence: "When trips or bookings arise",
    confidence: 0.78,
    status: "candidate",
    evidence: [
      "2 browser tasks stopped the flow before sensitive actions",
      "Approvel policies blocked payment and personal data sending",
      "Memory contains only route, date and comparison preference",
    ],
  },
  {
    id: "local_first_defaults",
    title: "Strong local-first preference",
    summary:
      "Cloud and managed providers stay disabled until you grant an explicit opt-in for the specific domain.",
    domain: "privacy",
    cadence: "Always",
    confidence: 0.92,
    status: "confirmed",
    evidence: [
      "Local inference provider selected as default",
      "Managed cloud marked as disabled in settings",
      "Write actions require user confirmation",
    ],
  },
];

export const automationProposals: AutomationProposal[] = [
  {
    id: "daily_project_briefing",
    title: "Morning project briefing",
    summary:
      "Prepare a local summary of git, open tasks, recent notes and blockers every morning.",
    trigger: "Weekdays at 08:45 or when you open the project",
    actions: [
      "Reads local repository and tasks",
      "Recalls redacted work memory",
      "Proposes the next action without sending anything",
    ],
    autonomyLevel: 2,
    risk: "low",
    status: "ready",
  },
  {
    id: "travel_watchlist",
    title: "Travel deals monitor",
    summary:
      "Watch a route and alert you when price, time or availability change meaningfully.",
    trigger: "When you save a route with a future date",
    actions: [
      "Opens the local browser in background",
      "Compares results with previous snapshots",
      "Asks approval before login or purchase",
    ],
    autonomyLevel: 3,
    risk: "medium",
    status: "needs_approval",
  },
  {
    id: "memory_candidate_review",
    title: "Weekly habit review",
    summary:
      "Show what the system thinks it learned and let you confirm, correct or delete.",
    trigger: "Every Friday afternoon",
    actions: [
      "Groups candidate insights by privacy domain",
      "Highlights redacted evidence and confidence level",
      "Applies only confirmed corrections",
    ],
    autonomyLevel: 1,
    risk: "low",
    status: "ready",
  },
];
