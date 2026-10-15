CREATE TABLE IF NOT EXISTS inbox (address TEXT NOT NULL, code TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_received ON inbox (address, received_at);
