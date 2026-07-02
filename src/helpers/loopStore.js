const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// Roomtone loop store — additive tables beside upstream's `notes`.
// Canonical DDL lives in docs/roomtone/loop-store.sql; this module embeds it
// verbatim so the schema ships inside the app bundle (docs/ does not).
// Pure module: takes a better-sqlite3 handle, no Electron imports, so it is
// testable with `node --test` like the other dependency-free helpers.

const LOOP_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    output_format TEXT NOT NULL,
    definition_of_done TEXT NOT NULL,
    deploy_spec   TEXT NOT NULL,
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
    note_id          INTEGER,
    template_id      TEXT REFERENCES templates(id),
    template_version INTEGER,
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
    CHECK (status != 'covered' OR evidence IS NOT NULL)
  );

  CREATE TABLE IF NOT EXISTS loop_outputs (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    kind        TEXT NOT NULL CHECK (kind IN
                 ('recap','hud_score','capture_candidate','crm_move_proposal','email_draft','insight')),
    content     TEXT NOT NULL,
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
`;

function initLoopStoreSchema(db) {
  db.exec(LOOP_STORE_SCHEMA);
}

// spec matches the shape of docs/roomtone/templates/*.json:
// { name, version, status, output_format, definition_of_done, deploy_spec, goals: [...] }
// Idempotent on (name, version): returns the existing template id if already present.
function createTemplate(db, spec) {
  if (!spec || !spec.name || !Array.isArray(spec.goals)) {
    throw new Error("Invalid template spec: name and goals are required");
  }
  const version = spec.version || 1;

  const existing = db
    .prepare("SELECT id FROM templates WHERE name = ? AND version = ?")
    .get(spec.name, version);
  if (existing) {
    return { id: existing.id, created: false };
  }

  const templateId = randomUUID();
  const insertTemplate = db.prepare(
    `INSERT INTO templates (id, name, version, output_format, definition_of_done, deploy_spec, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertGoal = db.prepare(
    `INSERT INTO template_goals (id, template_id, ord, label, kind, satisfied_when, value_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    insertTemplate.run(
      templateId,
      spec.name,
      version,
      JSON.stringify(spec.output_format || {}),
      JSON.stringify(spec.definition_of_done || {}),
      JSON.stringify(spec.deploy_spec || []),
      spec.status || "draft"
    );
    for (const goal of spec.goals) {
      insertGoal.run(
        randomUUID(),
        templateId,
        goal.ord,
        goal.label,
        goal.kind,
        goal.satisfied_when,
        goal.value_score != null ? goal.value_score : 1.0
      );
    }
  });
  run();

  return { id: templateId, created: true };
}

// Quick Note and Templated Session are the same row; templateId null = Quick Note.
// Capture is never gated — this must always succeed for a bare session.
function createSession(db, { noteId = null, templateId = null, engagement = null } = {}) {
  const sessionId = randomUUID();
  let templateVersion = null;
  if (templateId) {
    const template = db.prepare("SELECT version FROM templates WHERE id = ?").get(templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);
    templateVersion = template.version;
  }
  db.prepare(
    `INSERT INTO sessions (id, note_id, template_id, template_version, engagement)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, noteId, templateId, templateVersion, engagement);
  if (templateId) {
    db.prepare(
      "UPDATE templates SET reuse_count = reuse_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(templateId);
  }
  return sessionId;
}

// Retroactive promotion: a Quick Note becomes a templated session after the fact.
// Pins the template version at attach time and ticks reuse_count (refresh-on-read).
function attachTemplateToSession(db, sessionId, templateId) {
  const session = db.prepare("SELECT id, template_id FROM sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const template = db.prepare("SELECT id, version FROM templates WHERE id = ?").get(templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  const run = db.transaction(() => {
    db.prepare("UPDATE sessions SET template_id = ?, template_version = ? WHERE id = ?").run(
      templateId,
      template.version,
      sessionId
    );
    db.prepare(
      "UPDATE templates SET reuse_count = reuse_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(templateId);
  });
  run();

  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

// Read side of the promotion path: everything the picker UI needs in one row
// per template. goal_count rides along so a later UI can show template depth
// without a second query.
function listTemplates(db) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.version, t.status, t.reuse_count,
              (SELECT COUNT(*) FROM template_goals g WHERE g.template_id = t.id) AS goal_count
       FROM templates t
       ORDER BY t.name COLLATE NOCASE, t.version DESC`
    )
    .all();
}

// The live session for a note, or null (null = plain Quick Note, nothing
// attached yet). A note can accrue several sessions over time; the newest one
// is the one the UI speaks for. template_name is joined in so the renderer
// never needs a second round-trip to label the attachment.
function getSessionForNote(db, noteId) {
  if (noteId == null) return null;
  const row = db
    .prepare(
      `SELECT s.*, t.name AS template_name
       FROM sessions s LEFT JOIN templates t ON t.id = s.template_id
       WHERE s.note_id = ?
       ORDER BY s.started_at DESC, s.rowid DESC
       LIMIT 1`
    )
    .get(noteId);
  return row || null;
}

// One-call promotion: attach a template to a note, creating the session if
// the note never had one. Retroactive and additive -- the note row itself is
// untouched, so capture stays ungated no matter what happens here.
function attachTemplateToNote(db, noteId, templateId) {
  if (noteId == null) throw new Error("noteId is required");
  const run = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT id FROM sessions WHERE note_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1"
      )
      .get(noteId);
    if (existing) {
      attachTemplateToSession(db, existing.id, templateId);
      return existing.id;
    }
    // createSession with templateId pins the version and ticks reuse_count itself.
    return createSession(db, { noteId, templateId });
  });
  const sessionId = run();
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

function listLoopOutputsForSession(db, sessionId) {
  return db
    .prepare("SELECT * FROM loop_outputs WHERE session_id = ? ORDER BY created_at, rowid")
    .all(sessionId);
}

// Sessions with the context a reader needs: template, note title, pending
// count. Shared by the MCP surface and the daily companion.
function listSessionsWithContext(db, limit = 20) {
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db
    .prepare(
      `SELECT s.id, s.note_id, s.engagement, s.momentum_read, s.started_at,
              t.name AS template_name, t.version AS template_version,
              n.title AS note_title,
              (SELECT COUNT(*) FROM loop_outputs o
                WHERE o.session_id = s.id AND o.status = 'candidate') AS pending_candidates
       FROM sessions s
       LEFT JOIN templates t ON t.id = s.template_id
       LEFT JOIN notes n ON n.id = s.note_id
       ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(cap);
}

// The nod queue across every session, newest first.
function listPendingCandidates(db, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(
      `SELECT o.id, o.session_id, o.kind, o.content, o.destination, o.ttl_at, o.created_at,
              s.note_id, n.title AS note_title
       FROM loop_outputs o
       JOIN sessions s ON s.id = o.session_id
       LEFT JOIN notes n ON n.id = s.note_id
       WHERE o.status = 'candidate'
       ORDER BY o.created_at DESC LIMIT ?`
    )
    .all(cap);
}

// Everything the daily companion shows, one call: the nod queue, recent
// sessions, and open threads (pending capture candidates typed open_thread).
// Read-only by construction — nothing here mutates a row.
function getCompanionSummary(db) {
  const pending = listPendingCandidates(db, 200);
  const openThreads = pending.filter((o) => {
    if (o.kind !== "capture_candidate") return false;
    try {
      return JSON.parse(o.content)?.type === "open_thread";
    } catch {
      return false;
    }
  });
  return {
    pending,
    open_threads: openThreads,
    sessions: listSessionsWithContext(db, 15),
    counts: {
      pending: pending.length,
      open_threads: openThreads.length,
      approved_today: db
        .prepare(
          "SELECT COUNT(*) AS n FROM loop_outputs WHERE status = 'approved' AND date(decided_at) = date('now')"
        )
        .get().n,
    },
  };
}

// Invariant: no unexplained checkmarks — status='covered' with null evidence
// is rejected by the schema CHECK; the constraint error propagates.
function recordGoalEvent(
  db,
  { sessionId, goalId, status, evidence = null, scoredBy, atMs = null }
) {
  const eventId = randomUUID();
  db.prepare(
    `INSERT INTO goal_events (id, session_id, goal_id, status, evidence, scored_by, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, sessionId, goalId, status, evidence, scoredBy, atMs);
  return eventId;
}

// Every output lands as a candidate — the nod queue is a schema fact.
function createLoopOutput(db, { sessionId, kind, content, destination = null, ttlAt = null }) {
  const outputId = randomUUID();
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  db.prepare(
    `INSERT INTO loop_outputs (id, session_id, kind, content, destination, ttl_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(outputId, sessionId, kind, serialized, destination, ttlAt);
  return outputId;
}

// Lifecycle guard: only candidate -> approved. Anything else is an error,
// so a faded or committed output can never be quietly re-approved.
function approveLoopOutput(db, outputId) {
  const result = db
    .prepare(
      "UPDATE loop_outputs SET status = 'approved', decided_at = datetime('now') WHERE id = ? AND status = 'candidate'"
    )
    .run(outputId);
  if (result.changes === 0) {
    const row = db.prepare("SELECT status FROM loop_outputs WHERE id = ?").get(outputId);
    if (!row) throw new Error(`Loop output not found: ${outputId}`);
    throw new Error(`Cannot approve loop output in status '${row.status}' (must be 'candidate')`);
  }
  return db.prepare("SELECT * FROM loop_outputs WHERE id = ?").get(outputId);
}

// The explicit "no": candidate -> faded. Same lifecycle guard as approve —
// an approved or committed output can never be quietly faded, and a faded
// one can never come back. Doing nothing still fades on TTL; this is just
// Cory clearing the queue on purpose.
function fadeLoopOutput(db, outputId) {
  const result = db
    .prepare(
      "UPDATE loop_outputs SET status = 'faded', decided_at = datetime('now') WHERE id = ? AND status = 'candidate'"
    )
    .run(outputId);
  if (result.changes === 0) {
    const row = db.prepare("SELECT status FROM loop_outputs WHERE id = ?").get(outputId);
    if (!row) throw new Error(`Loop output not found: ${outputId}`);
    throw new Error(`Cannot fade loop output in status '${row.status}' (must be 'candidate')`);
  }
  return db.prepare("SELECT * FROM loop_outputs WHERE id = ?").get(outputId);
}

function recordTuningEvent(db, { sessionId, goalId = null, outputId = null, signal, note = null }) {
  const eventId = randomUUID();
  db.prepare(
    `INSERT INTO tuning_events (id, session_id, goal_id, output_id, signal, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(eventId, sessionId, goalId, outputId, signal, note);
  return eventId;
}

// Seed the bundled starter templates (docs/roomtone/templates/*.json) if not
// already present. Safe to run on every startup; skips silently when the docs
// directory is not shipped (packaged builds).
function seedDefaultTemplates(db, templatesDir) {
  const dir = templatesDir || path.join(__dirname, "..", "..", "docs", "roomtone", "templates");
  if (!fs.existsSync(dir)) return [];

  const seeded = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const result = createTemplate(db, spec);
    seeded.push({ file, ...result });
  }
  return seeded;
}

module.exports = {
  LOOP_STORE_SCHEMA,
  initLoopStoreSchema,
  createTemplate,
  createSession,
  attachTemplateToSession,
  listTemplates,
  getSessionForNote,
  attachTemplateToNote,
  listLoopOutputsForSession,
  listSessionsWithContext,
  listPendingCandidates,
  getCompanionSummary,
  recordGoalEvent,
  createLoopOutput,
  approveLoopOutput,
  fadeLoopOutput,
  recordTuningEvent,
  seedDefaultTemplates,
};
