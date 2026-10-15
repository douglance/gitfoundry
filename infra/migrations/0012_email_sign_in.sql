-- GitFoundry's own email-code sign-in: one-time codes, accounts keyed by email, and browser sessions.
-- Codes and session tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS auth_email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_email_codes_by_email ON auth_email_codes(email, created_at);

CREATE TABLE IF NOT EXISTS auth_accounts (
  email TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_browser_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
