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
  project_id        TEXT,  -- the project a client brief was attached to, if any
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

-- Blueprint section 11.2: projects. A project is identified by its client and
-- project name (unique, ignoring case), because files are named from them.
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,  -- uuid
  client_name     TEXT NOT NULL,
  project_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'shared_with_client' | 'baselined'
  chat_id         TEXT,              -- the project's Dramantram-only group chat
  folder_backend  TEXT,              -- 'onedrive' | 'sharepoint'
  folder_owner    TEXT,              -- whose OneDrive holds the folder
  folder_name     TEXT,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_activity   TEXT,
  cleared_at      TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects (client_name COLLATE NOCASE, project_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS project_versions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects (id),
  version           INTEGER NOT NULL,
  file_name         TEXT NOT NULL,
  backend           TEXT NOT NULL,   -- which storage wrote it, so switching never orphans a version
  file_ref          TEXT,
  file_owner        TEXT,            -- whose drive holds the file (the folder owner, or the organiser if the owner's sign-in had expired)
  uploaded_etag     TEXT,            -- what the bot uploaded, to detect later edits
  uploaded_at       TEXT NOT NULL,
  source_meeting_id TEXT,
  change_summary    TEXT,
  snapshot          TEXT,            -- the document's values as the bot wrote them (JSON), to tell a person's later edit from its own text
  created_by        TEXT,
  UNIQUE (project_id, version)
);

-- Prompts waiting on a person. Held here, not in memory, so a restart or a
-- deploy does not strand them (slice 2.2).
CREATE TABLE IF NOT EXISTS pending_decisions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,  -- 'confirm_meeting' | 'choose_project' | 'confirm_baseline' | 'confirm_changes'
  user_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,  -- JSON
  status     TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'answered' | 'expired'
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
