-- Blueprint section 10: data model.

-- Delegated auth has no table here: the Bot Framework Token Service holds the
-- refresh tokens and rotates them, so this process stores none.

-- One row per meeting the bot considered, whether or not it produced a CBD.
CREATE TABLE IF NOT EXISTS meeting_logs (
  id                TEXT PRIMARY KEY,  -- uuid
  meeting_id        TEXT NOT NULL,
  meeting_title     TEXT,
  user_id           TEXT,
  hosted_by         TEXT,  -- 'dramantram' | 'external'
  filter_result     TEXT,  -- 'processed' | 'skipped_short' | 'skipped_user' | 'unresolved_attendees'
  transcript_source TEXT,  -- 'application' | 'delegated' | 'manual_upload'
  cbd_generated     INTEGER DEFAULT 0,  -- 1 once any output was generated, a CBD or a meeting brief
  output_kind       TEXT,  -- 'client_brief' | 'meeting_brief'
  cbd_file_path     TEXT,
  confidence_avg    REAL,
  transcript_ids    TEXT,  -- comma-separated Graph transcript IDs this row covers: a repeat notification for one is ignored, a new one is a new session
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_logs_meeting ON meeting_logs (meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_user    ON meeting_logs (user_id);

-- Beyond blueprint section 10: Bot Framework can only start a conversation with
-- a user it has seen before, so the reference from their first interaction has
-- to be kept or the bot can never DM them a finished brief.
CREATE TABLE IF NOT EXISTS conversation_refs (
  user_id    TEXT PRIMARY KEY,
  reference  TEXT NOT NULL,   -- JSON ConversationReference
  updated_at TEXT NOT NULL
);
