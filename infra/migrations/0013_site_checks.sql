-- Results of production's scheduled repository load check, kept for seven days.
CREATE TABLE IF NOT EXISTS site_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK(ok IN (0, 1)),
  stage TEXT,
  code TEXT,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS site_checks_by_time ON site_checks(checked_at);
