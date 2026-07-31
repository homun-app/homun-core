import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_THREAD_FILTER,
  normalizeThreadFilter,
  projectThreads,
  threadFilterCount,
  threadFilterIsActive,
  threadSourceKey,
  threadUpdatedMs,
} from "./threadFilter.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 31, 12, 0, 0);
const PERSONAL_WORKSPACE_ID = "personal";

function makeThread(threadId, overrides = {}) {
  return {
    threadId,
    workspaceId: PERSONAL_WORKSPACE_ID,
    title: threadId,
    subtitle: "",
    status: "active",
    pinned: false,
    computerSessionId: "",
    taskId: "",
    updatedAt: String(NOW),
    messageCount: 0,
    source: null,
    ...overrides,
  };
}

function makeFilter(overrides = {}) {
  return normalizeThreadFilter({ ...EMPTY_THREAD_FILTER, ...overrides });
}

function projectedIds(groups) {
  return groups.flatMap((group) => group.threads.map((thread) => thread.threadId));
}

test("exports the canonical empty thread filter", () => {
  assert.deepEqual(EMPTY_THREAD_FILTER, {
    groupBy: "none",
    order: "updated_desc",
    states: [],
    types: [],
    period: "all",
    projects: [],
    channels: [],
    tagIds: [],
    showArchived: false,
  });
});

test("normalization returns fresh empty filters for invalid roots", () => {
  const normalized = [null, undefined, "stored", 42, [], true].map(normalizeThreadFilter);

  for (const value of normalized) {
    assert.deepEqual(value, EMPTY_THREAD_FILTER);
    assert.notStrictEqual(value, EMPTY_THREAD_FILTER);
    assert.notStrictEqual(value.states, EMPTY_THREAD_FILTER.states);
    assert.notStrictEqual(value.types, EMPTY_THREAD_FILTER.types);
    assert.notStrictEqual(value.projects, EMPTY_THREAD_FILTER.projects);
    assert.notStrictEqual(value.channels, EMPTY_THREAD_FILTER.channels);
    assert.notStrictEqual(value.tagIds, EMPTY_THREAD_FILTER.tagIds);
  }
  assert.notStrictEqual(normalized[0].states, normalized[1].states);
});

test("normalization accepts only known scalar enum values and literal true", () => {
  assert.deepEqual(
    normalizeThreadFilter({
      groupBy: "channel",
      order: "title_asc",
      period: "30d",
      showArchived: true,
    }),
    {
      ...EMPTY_THREAD_FILTER,
      groupBy: "channel",
      order: "title_asc",
      period: "30d",
      showArchived: true,
    },
  );

  assert.deepEqual(
    normalizeThreadFilter({
      groupBy: "workspace",
      order: "newest",
      period: "week",
      showArchived: 1,
    }),
    EMPTY_THREAD_FILTER,
  );
});

test("normalization filters and deduplicates arrays without mutating stored input", () => {
  const stored = {
    states: ["waiting_user", " working ", "failed", "waiting_user", null, "idle"],
    types: ["project", "chat", "project", "channel"],
    projects: [" alpha ", "", "alpha", 12, "beta"],
    channels: [" slack ", "slack", "  ", null, "chat"],
    tagIds: [" urgent ", "urgent", "review", false],
  };
  const before = structuredClone(stored);

  const normalized = normalizeThreadFilter(stored);

  assert.deepEqual(normalized.states, ["waiting_user", "failed"]);
  assert.deepEqual(normalized.types, ["project", "chat"]);
  assert.deepEqual(normalized.projects, ["alpha", "beta"]);
  assert.deepEqual(normalized.channels, ["slack", "chat"]);
  assert.deepEqual(normalized.tagIds, ["urgent", "review"]);
  assert.deepEqual(stored, before);
});

test("normalized arrays never share mutable state with input or the empty constant", () => {
  const input = { states: ["working"], projects: ["alpha"] };
  const emptyBefore = structuredClone(EMPTY_THREAD_FILTER);
  const normalized = normalizeThreadFilter(input);

  normalized.states.push("failed");
  normalized.projects.push("beta");

  assert.deepEqual(input, { states: ["working"], projects: ["alpha"] });
  assert.deepEqual(EMPTY_THREAD_FILTER, emptyBefore);
});

test("filter count includes every array entry and each non-default scalar", () => {
  const filter = makeFilter({
    groupBy: "project",
    order: "title_asc",
    states: ["working", "failed"],
    types: ["chat"],
    period: "7d",
    projects: ["alpha", "beta"],
    channels: ["slack"],
    tagIds: ["urgent", "review"],
    showArchived: true,
  });

  assert.equal(threadFilterCount(EMPTY_THREAD_FILTER), 0);
  assert.equal(threadFilterIsActive(EMPTY_THREAD_FILTER), false);
  assert.equal(threadFilterCount(filter), 12);
  assert.equal(threadFilterIsActive(filter), true);
});

test("source and timestamp helpers preserve legacy formats", () => {
  assert.equal(threadSourceKey(makeThread("chat", { source: null })), "chat");
  assert.equal(threadSourceKey(makeThread("legacy", { source: undefined })), "chat");
  assert.equal(threadSourceKey(makeThread("slack", { source: "slack" })), "slack");
  assert.equal(threadUpdatedMs("1769857200"), 1_769_857_200_000);
  assert.equal(threadUpdatedMs("1769857200000"), 1_769_857_200_000);
  assert.equal(threadUpdatedMs("2026-01-31T11:00:00.000Z"), 1_769_857_200_000);
  assert.equal(threadUpdatedMs(""), 0);
  assert.equal(threadUpdatedMs("not-a-date"), 0);
});

test("parses numeric timestamps around the app seconds-to-milliseconds threshold", () => {
  assert.equal(threadUpdatedMs("99999999999"), 99_999_999_999_000);
  assert.equal(threadUpdatedMs("100000000000"), 100_000_000_000);
  assert.equal(threadUpdatedMs("100000000001"), 100_000_000_001);
  assert.equal(threadUpdatedMs("999999999999"), 999_999_999_999);
});

test("sorts projection by parsed time around the numeric magnitude threshold", () => {
  const threads = [
    makeThread("below-seconds", { updatedAt: "99999999999" }),
    makeThread("at-milliseconds", { updatedAt: "100000000000" }),
    makeThread("above-milliseconds", { updatedAt: "100000000001" }),
    makeThread("twelve-digit-milliseconds", { updatedAt: "999999999999" }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(threads, EMPTY_THREAD_FILTER, {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    [
      "below-seconds",
      "twelve-digit-milliseconds",
      "above-milliseconds",
      "at-milliseconds",
    ],
  );
});

test("projection combines state type project channel tag and archive axes with AND", () => {
  const threads = [
    makeThread("match-waiting", { workspaceId: "project-a", source: "slack" }),
    makeThread("match-failed", { workspaceId: "project-b", source: "chat" }),
    makeThread("wrong-state", { workspaceId: "project-a", source: "slack" }),
    makeThread("wrong-project", { workspaceId: "project-c", source: "slack" }),
    makeThread("wrong-tag", { workspaceId: "project-a", source: "slack" }),
    makeThread("archived", {
      workspaceId: "project-a",
      source: "slack",
      status: "archived",
    }),
  ];
  const filter = makeFilter({
    states: ["waiting_user", "failed"],
    types: ["project"],
    projects: ["project-a", "project-b"],
    channels: ["slack", "chat"],
    tagIds: ["urgent", "review"],
  });
  const attention = {
    "match-waiting": "waiting_user",
    "match-failed": "failed",
    "wrong-state": "idle",
    "wrong-project": "failed",
    "wrong-tag": "waiting_user",
    archived: "failed",
  };
  const tags = {
    "match-waiting": ["urgent"],
    "match-failed": ["review"],
    "wrong-state": ["urgent"],
    "wrong-project": ["urgent"],
    "wrong-tag": ["later"],
    archived: ["urgent"],
  };

  assert.deepEqual(
    projectedIds(projectThreads(threads, filter, attention, tags, PERSONAL_WORKSPACE_ID, NOW)),
    ["match-failed", "match-waiting"],
  );
});

test("waiting_user or failed states replace the attention-only convenience filter", () => {
  const threads = ["working", "completed", "waiting", "failed", "idle", "absent"].map((id) =>
    makeThread(id),
  );
  const attention = {
    working: "working",
    completed: "completed_unread",
    waiting: "waiting_user",
    failed: "failed",
    idle: "idle",
  };
  const filter = makeFilter({ states: ["waiting_user", "failed"] });

  assert.deepEqual(
    projectedIds(projectThreads(threads, filter, attention, {}, PERSONAL_WORKSPACE_ID, NOW)),
    ["failed", "waiting"],
  );
});

test("archive filtering defaults off and literal showArchived includes archived threads", () => {
  const threads = [
    makeThread("active"),
    makeThread("archived", { status: "archived" }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(threads, EMPTY_THREAD_FILTER, {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    ["active"],
  );
  assert.deepEqual(
    projectedIds(
      projectThreads(
        threads,
        makeFilter({ showArchived: true }),
        {},
        {},
        PERSONAL_WORKSPACE_ID,
        NOW,
      ),
    ),
    ["active", "archived"],
  );
});

test("personal and legacy workspaces are chats and use the personal project key", () => {
  const threads = [
    makeThread("personal"),
    makeThread("legacy-null", { workspaceId: null }),
    makeThread("legacy-undefined", { workspaceId: undefined }),
    makeThread("project", { workspaceId: "project-a" }),
  ];
  const personalFilter = makeFilter({ types: ["chat"], projects: [PERSONAL_WORKSPACE_ID] });
  const projectFilter = makeFilter({ types: ["project"] });

  assert.deepEqual(
    projectedIds(projectThreads(threads, personalFilter, {}, {}, PERSONAL_WORKSPACE_ID, NOW)),
    ["legacy-null", "legacy-undefined", "personal"],
  );
  assert.deepEqual(
    projectedIds(projectThreads(threads, projectFilter, {}, {}, PERSONAL_WORKSPACE_ID, NOW)),
    ["project"],
  );
});

test("period filters are inclusive, accept future timestamps, and reject invalid timestamps", () => {
  const threads = [
    makeThread("future", { updatedAt: new Date(NOW + DAY_MS).toISOString() }),
    makeThread("now", { updatedAt: String(NOW) }),
    makeThread("today-boundary", { updatedAt: String((NOW - DAY_MS) / 1000) }),
    makeThread("after-today", { updatedAt: String(NOW - DAY_MS - 1) }),
    makeThread("week-boundary", { updatedAt: String(NOW - 7 * DAY_MS) }),
    makeThread("after-week", { updatedAt: String(NOW - 7 * DAY_MS - 1) }),
    makeThread("month-boundary", { updatedAt: new Date(NOW - 30 * DAY_MS).toISOString() }),
    makeThread("after-month", { updatedAt: String(NOW - 30 * DAY_MS - 1) }),
    makeThread("invalid", { updatedAt: "invalid" }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(threads, makeFilter({ period: "today" }), {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    ["future", "now", "today-boundary"],
  );
  assert.deepEqual(
    projectedIds(
      projectThreads(threads, makeFilter({ period: "7d" }), {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    ["future", "now", "today-boundary", "after-today", "week-boundary"],
  );
  assert.deepEqual(
    projectedIds(
      projectThreads(threads, makeFilter({ period: "30d" }), {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    [
      "future",
      "now",
      "today-boundary",
      "after-today",
      "week-boundary",
      "after-week",
      "month-boundary",
    ],
  );
});

test("sorting keeps pinned threads first and uses deterministic updated-desc tie breaks", () => {
  const threads = [
    makeThread("z-new", { title: "Zulu", updatedAt: String(NOW) }),
    makeThread("b-tie", { title: "Same", updatedAt: String(NOW - DAY_MS) }),
    makeThread("a-tie", { title: "Same", updatedAt: String(NOW - DAY_MS) }),
    makeThread("alpha-tie", { title: "alpha", updatedAt: String(NOW - DAY_MS) }),
    makeThread("pinned-old", { pinned: true, updatedAt: String(NOW - 30 * DAY_MS) }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(threads, EMPTY_THREAD_FILTER, {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    ),
    ["pinned-old", "z-new", "alpha-tie", "a-tie", "b-tie"],
  );
});

test("updated-asc sorting is deterministic for invalid timestamps and ties", () => {
  const threads = [
    makeThread("new", { updatedAt: String(NOW) }),
    makeThread("invalid-b", { title: "same", updatedAt: "invalid" }),
    makeThread("old", { updatedAt: String(NOW - DAY_MS) }),
    makeThread("invalid-a", { title: "same", updatedAt: "invalid" }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(
        threads,
        makeFilter({ order: "updated_asc" }),
        {},
        {},
        PERSONAL_WORKSPACE_ID,
        NOW,
      ),
    ),
    ["invalid-a", "invalid-b", "old", "new"],
  );
});

test("title-asc sorting is case-insensitive with exact-title and id tie breaks", () => {
  const threads = [
    makeThread("zulu", { title: "Zulu" }),
    makeThread("alpha-lower", { title: "alpha" }),
    makeThread("same-b", { title: "Beta" }),
    makeThread("same-a", { title: "Beta" }),
    makeThread("alpha-upper", { title: "Alpha" }),
    makeThread("pinned", { title: "zzzz", pinned: true }),
  ];

  assert.deepEqual(
    projectedIds(
      projectThreads(
        threads,
        makeFilter({ order: "title_asc" }),
        {},
        {},
        PERSONAL_WORKSPACE_ID,
        NOW,
      ),
    ),
    ["pinned", "alpha-upper", "alpha-lower", "same-a", "same-b", "zulu"],
  );
});

test("none grouping always returns one all group, including for empty results", () => {
  assert.deepEqual(
    projectThreads([], EMPTY_THREAD_FILTER, {}, {}, PERSONAL_WORKSPACE_ID, NOW),
    [{ key: "all", threads: [] }],
  );
  assert.deepEqual(
    projectThreads(
      [makeThread("one")],
      EMPTY_THREAD_FILTER,
      {},
      {},
      PERSONAL_WORKSPACE_ID,
      NOW,
    ).map((group) => group.key),
    ["all"],
  );
});

test("project grouping canonicalizes personal workspaces and omits empty groups", () => {
  const threads = [
    makeThread("project-new", { workspaceId: "project-a", updatedAt: String(NOW) }),
    makeThread("legacy", { workspaceId: null, updatedAt: String(NOW - DAY_MS) }),
    makeThread("personal", { updatedAt: String(NOW - 2 * DAY_MS) }),
    makeThread("project-old", { workspaceId: "project-a", updatedAt: String(NOW - 3 * DAY_MS) }),
  ];
  const groups = projectThreads(
    threads,
    makeFilter({ groupBy: "project" }),
    {},
    {},
    PERSONAL_WORKSPACE_ID,
    NOW,
  );

  assert.deepEqual(
    groups.map((group) => [group.key, group.threads.map((thread) => thread.threadId)]),
    [
      ["project-a", ["project-new", "project-old"]],
      [PERSONAL_WORKSPACE_ID, ["legacy", "personal"]],
    ],
  );
});

test("channel grouping uses the source key and retains sorted order", () => {
  const threads = [
    makeThread("slack-new", { source: "slack", updatedAt: String(NOW) }),
    makeThread("chat", { updatedAt: String(NOW - DAY_MS) }),
    makeThread("slack-old", { source: "slack", updatedAt: String(NOW - 2 * DAY_MS) }),
  ];
  const groups = projectThreads(
    threads,
    makeFilter({ groupBy: "channel" }),
    {},
    {},
    PERSONAL_WORKSPACE_ID,
    NOW,
  );

  assert.deepEqual(
    groups.map((group) => [group.key, group.threads.map((thread) => thread.threadId)]),
    [
      ["slack", ["slack-new", "slack-old"]],
      ["chat", ["chat"]],
    ],
  );
});

test("period grouping is mutually exclusive and follows stable group order", () => {
  const threads = [
    makeThread("older", { updatedAt: String(NOW - 31 * DAY_MS) }),
    makeThread("invalid", { updatedAt: "invalid" }),
    makeThread("month", { updatedAt: String(NOW - 8 * DAY_MS) }),
    makeThread("week", { updatedAt: String(NOW - 2 * DAY_MS) }),
    makeThread("today", { updatedAt: String(NOW - DAY_MS) }),
    makeThread("future", { updatedAt: String(NOW + DAY_MS) }),
  ];
  const groups = projectThreads(
    threads,
    makeFilter({ groupBy: "period", order: "updated_asc" }),
    {},
    {},
    PERSONAL_WORKSPACE_ID,
    NOW,
  );

  assert.deepEqual(
    groups.map((group) => [group.key, group.threads.map((thread) => thread.threadId)]),
    [
      ["today", ["today", "future"]],
      ["7d", ["week"]],
      ["30d", ["month"]],
      ["older", ["invalid", "older"]],
    ],
  );
});

test("period filtering and period grouping remain independent", () => {
  const threads = [
    makeThread("today", { updatedAt: String(NOW) }),
    makeThread("week", { updatedAt: String(NOW - 3 * DAY_MS) }),
    makeThread("month", { updatedAt: String(NOW - 20 * DAY_MS) }),
  ];
  const groups = projectThreads(
    threads,
    makeFilter({ groupBy: "period", period: "7d" }),
    {},
    {},
    PERSONAL_WORKSPACE_ID,
    NOW,
  );

  assert.deepEqual(
    groups.map((group) => [group.key, group.threads.map((thread) => thread.threadId)]),
    [
      ["today", ["today"]],
      ["7d", ["week"]],
    ],
  );
});

test("projects the canonical mixed-filter example", () => {
  const threads = [
    makeThread("selected", {
      workspaceId: "project-a",
      source: "slack",
      title: "Selected",
      pinned: true,
      updatedAt: String(NOW - 2 * DAY_MS),
    }),
    makeThread("wrong-channel", { workspaceId: "project-a", source: "email" }),
    makeThread("wrong-workspace", { workspaceId: "project-b", source: "slack" }),
    makeThread("stale", {
      workspaceId: "project-a",
      source: "slack",
      updatedAt: String(NOW - 8 * DAY_MS),
    }),
  ];
  const filter = makeFilter({
    groupBy: "project",
    order: "updated_desc",
    states: ["working", "waiting_user"],
    types: ["project"],
    period: "7d",
    projects: ["project-a"],
    channels: ["slack"],
    tagIds: ["priority"],
  });
  const attention = {
    selected: "waiting_user",
    "wrong-channel": "working",
    "wrong-workspace": "working",
    stale: "working",
  };
  const tags = Object.fromEntries(threads.map((thread) => [thread.threadId, ["priority"]]));

  assert.deepEqual(
    projectThreads(threads, filter, attention, tags, PERSONAL_WORKSPACE_ID, NOW).map((group) => [
      group.key,
      group.threads.map((thread) => thread.threadId),
    ]),
    [["project-a", ["selected"]]],
  );
});

test("projection does not mutate threads, filter, attention, or tag maps", () => {
  const threads = [
    makeThread("second", { title: "Second", updatedAt: String(NOW - DAY_MS) }),
    makeThread("first", { title: "First", updatedAt: String(NOW) }),
  ];
  const filter = makeFilter({ states: ["working"], tagIds: ["urgent"] });
  const attention = { first: "working", second: "working" };
  const tags = { first: ["urgent"], second: ["urgent"] };
  const before = structuredClone({ threads, filter, attention, tags });

  const groups = projectThreads(
    threads,
    filter,
    attention,
    tags,
    PERSONAL_WORKSPACE_ID,
    NOW,
  );

  assert.deepEqual({ threads, filter, attention, tags }, before);
  assert.notStrictEqual(groups[0].threads, threads);
});
