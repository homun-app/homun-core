-- Drop the Business Autopilot tables.
--
-- The business feature introduced in migration 015 is being removed from the
-- codebase because it will be rewritten with a completely different logic.
-- Rather than keeping orphan tables with no code accessing them, we drop them
-- cleanly here so existing installations converge with fresh ones.
--
-- `DROP TABLE IF EXISTS` is safe for both cases:
--   * Existing installs where 015 already ran → tables are removed.
--   * Fresh installs where 015 was never applied (file deleted) → no-op.

DROP TABLE IF EXISTS market_insights;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS business_strategies;
DROP TABLE IF EXISTS businesses;
