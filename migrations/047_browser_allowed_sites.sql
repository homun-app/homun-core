-- Browser allowed sites: per-domain allowlist with rendering mode.
--
-- Controls which websites the browser agent can navigate to,
-- and whether each site should open in headless, visible, or auto mode.
-- Sites not in this table require user approval before navigation.

CREATE TABLE IF NOT EXISTS browser_allowed_sites (
    domain      TEXT PRIMARY KEY,
    mode        TEXT NOT NULL DEFAULT 'headless' CHECK(mode IN ('headless', 'visible', 'auto')),
    added_by    TEXT NOT NULL DEFAULT 'user',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    notes       TEXT
);

-- Seed: common safe sites that work well in headless mode
INSERT OR IGNORE INTO browser_allowed_sites (domain, mode, added_by, notes) VALUES
    ('google.com',      'headless', 'system', 'Search engine'),
    ('google.it',       'headless', 'system', 'Search engine (IT)'),
    ('bing.com',        'headless', 'system', 'Search engine'),
    ('duckduckgo.com',  'headless', 'system', 'Search engine'),
    ('wikipedia.org',   'headless', 'system', 'Reference'),
    ('github.com',      'headless', 'system', 'Code hosting');
