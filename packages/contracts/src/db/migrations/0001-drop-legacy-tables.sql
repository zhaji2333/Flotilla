-- One-time cleanup for tables retired before versioned migrations existed.
-- Applied at most once per database; safe on a fresh database.
DROP TABLE IF EXISTS traffic_evidence;
DROP TABLE IF EXISTS portfolio_actions;
DROP TABLE IF EXISTS portfolio_runs;
DROP TABLE IF EXISTS portfolio_lease;
