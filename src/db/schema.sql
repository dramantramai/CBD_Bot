-- Blueprint section 10: data model.

-- Delegated auth: one encrypted refresh token per Dramantram user, captured
-- during the one-time Teams SSO sign-in.
CREATE TABLE IF NOT EXISTS user_tokens (
  user_id          TEXT PRIMARY KEY,   -- Azure AD object id
  display_name     TEXT,
  email            TEXT,
  refresh_token    TEXT NOT NULL,      -- AES-256-GCM, see src/utils/crypto.js
  token_expires_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- One row per meeting the bot considered, whether or not it produced a CBD.
CREATE TABLE IF NOT EXISTS meeting_logs (
  id                TEXT PRIMARY KEY,  -- uuid
  meeting_id        TEXT NOT NULL,
  meeting_title     TEXT,
  user_id           TEXT,
  hosted_by         TEXT,  -- 'dramantram' | 'external'
  filter_result     TEXT,  -- 'processed' | 'skipped_internal' | 'skipped_short' | 'skipped_user'
  transcript_source TEXT,  -- 'application' | 'delegated' | 'manual_upload'
  cbd_generated     INTEGER DEFAULT 0,
  cbd_file_path     TEXT,
  confidence_avg    REAL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_logs_meeting ON meeting_logs (meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_user    ON meeting_logs (user_id);

-- Future learning layer: titles a user repeatedly declines to brief.
CREATE TABLE IF NOT EXISTS skipped_titles (
  user_id       TEXT NOT NULL,
  title_pattern TEXT NOT NULL,
  skip_count    INTEGER NOT NULL DEFAULT 0,
  auto_skip     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, title_pattern)
);

-- Beyond blueprint section 10: Bot Framework can only start a conversation with
-- a user it has seen before, so the reference from their first interaction has
-- to be kept or the bot can never DM them a finished brief.
CREATE TABLE IF NOT EXISTS conversation_refs (
  user_id    TEXT PRIMARY KEY,
  reference  TEXT NOT NULL,   -- JSON ConversationReference
  updated_at TEXT NOT NULL
);
