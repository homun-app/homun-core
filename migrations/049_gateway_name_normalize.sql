-- Normalize gateway display names: strip type prefix.
-- "Email: default" → "default", "Email: lavoro" → "lavoro"
-- The gateway_channel_name() helper handles both formats, so this is
-- a cosmetic cleanup + ensures future lookups are consistent.
UPDATE gateways
SET name = SUBSTR(name, 8), updated_at = datetime('now')
WHERE channel_type = 'email' AND name LIKE 'Email: %';
