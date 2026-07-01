-- Roomtone loop store — v1 (2026-07-01)
-- Additive tables beside upstream's `notes`. SQLite (better-sqlite3).
-- Not yet wired into src/helpers/database.js — first coding session does that
-- through upstream's existing migration mechanism, not by hand-running this.

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  output_format TEXT NOT NULL,            -- json
  definition_of_done TEXT NOT NULL,       -- json
  deploy_spec   TEXT NOT NULL,            -- json, ordered
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','validated','productized')),
  reuse_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS template_goals (
  id             TEXT PRIMARY KEY,
  template_id    TEXT NOT NULL REFERENCES templates(id),
  ord            INTEGER NOT NULL,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('bucket','behavior')),
  satisfied_when TEXT NOT NULL,
  value_score    REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  note_id          INTEGER,               -- fk -> upstream notes.id (not enforced across schemas)
  template_id      TEXT REFERENCES templates(id),   -- null = Quick Note
  template_version INTEGER,               -- pinned at attach time
  engagement       TEXT,
  momentum_read    TEXT CHECK (momentum_read IN ('built','leaked','mixed') OR momentum_read IS NULL),
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT
);

CREATE TABLE IF NOT EXISTS goal_events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  goal_id    TEXT NOT NULL REFERENCES template_goals(id),
  status     TEXT NOT NULL CHECK (status IN ('covered','partial','missed')),
  evidence   TEXT,
  scored_by  TEXT NOT NULL CHECK (scored_by IN ('retro','live_matcher','claude')),
  at_ms      INTEGER,
  -- Invariant #2: no unexplained checkmarks.
  CHECK (status != 'covered' OR evidence IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS loop_outputs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  kind        TEXT NOT NULL CHECK (kind IN
               ('recap','hud_score','capture_candidate','crm_move_proposal','email_draft','insight')),
  content     TEXT NOT NULL,              -- json or text
  status      TEXT NOT NULL DEFAULT 'candidate'
              CHECK (status IN ('candidate','approved','committed','faded')),
  destination TEXT,
  ttl_at      TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tuning_events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  goal_id    TEXT REFERENCES template_goals(id),
  output_id  TEXT REFERENCES loop_outputs(id),
  signal     TEXT NOT NULL CHECK (signal IN ('kept','redone','cut','nudge_wanted')),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_template   ON sessions(template_id);
CREATE INDEX IF NOT EXISTS idx_goal_events_session ON goal_events(session_id);
CREATE INDEX IF NOT EXISTS idx_outputs_session     ON loop_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_outputs_status      ON loop_outputs(status);
CREATE INDEX IF NOT EXISTS idx_tuning_session      ON tuning_events(session_id);
