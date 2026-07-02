const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Database = require("better-sqlite3");

const {
  initLoopStoreSchema,
  seedDefaultTemplates,
  createSession,
  listLoopOutputsForSession,
  approveLoopOutput,
} = require("../../src/helpers/loopStore");

const {
  loadSynthesisContext,
  buildSynthesisPrompt,
  parseSynthesisResponse,
  computeHudScore,
  runSynthesis,
} = require("../../src/helpers/synthesisRunner");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "docs", "roomtone", "templates");

// Minimal mirror of upstream's notes table — just the columns the runner reads.
const NOTES_FIXTURE = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled Note',
    content TEXT NOT NULL DEFAULT '',
    transcript TEXT
  );
`;

const TRANSCRIPT = [
  "Josh: So walk me through a typical week. Honestly the whole estimating process is me at the kitchen table on Sunday nights.",
  "Cory: What happens after the estimate goes out?",
  "Josh: We chase it. Sarah keeps a spreadsheet but half the time the follow-up just does not happen.",
  "Josh: We tried one of those AI note things for a month and nobody opened it after week two.",
  "Cory: If you got ten hours a week back, where would they go?",
  "Josh: I would actually visit the job sites again. That is the part of the business I miss.",
  "Cory: So next steps — I will draft the estimating workflow map, you send me two recent estimates, and we meet Thursday.",
].join("\n");

const openDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthesis-test-"));
  const db = new Database(path.join(dir, "synthesis.db"));
  db.exec(NOTES_FIXTURE);
  initLoopStoreSchema(db);
  seedDefaultTemplates(db, TEMPLATES_DIR);
  return db;
};

const setupSession = (db, { transcript = TRANSCRIPT } = {}) => {
  const noteId = db
    .prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)")
    .run("Josh discovery call", transcript).lastInsertRowid;
  const template = db.prepare("SELECT * FROM templates LIMIT 1").get();
  const sessionId = createSession(db, { noteId: Number(noteId), templateId: template.id });
  const goals = db
    .prepare("SELECT * FROM template_goals WHERE template_id = ? ORDER BY ord")
    .all(template.id);
  return { noteId: Number(noteId), template, sessionId, goals };
};

// A well-behaved Claude: verbatim evidence, full shape.
const goodResponse = (goals) =>
  JSON.stringify({
    momentum_read: "built",
    goal_scores: goals.map((g, i) => ({
      goal_id: g.id,
      status: i === 0 ? "covered" : "partial",
      evidence:
        i === 0 ? "the whole estimating process is me at the kitchen table on Sunday nights" : null,
    })),
    recap: {
      part1: { how_it_went: "Warm, candid.", by_bucket: "Estimating is the pain center." },
      part2: { decided_this_session: "Workflow map by Thursday." },
    },
    capture_candidates: [
      { type: "anchor_phrase", content: "me at the kitchen table on Sunday nights" },
      { type: "open_thread", content: "Follow-up on estimates dies in a spreadsheet" },
    ],
    crm_move_proposal: {
      next_step: "Send estimating workflow map before Thursday session",
      next_step_date_hint: "Thursday",
      touch_summary: "Discovery call — estimating pain named, two estimates incoming",
    },
    email_draft: {
      subject: "Thursday + the two estimates",
      body: "Josh — good talking today. Send those two recent estimates when you get a minute and I'll have the workflow map ready for Thursday.",
    },
  });

test("runSynthesis happy path: goal events + all five output kinds, all candidates", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);

  const result = await runSynthesis(db, {
    sessionId,
    generate: async () => goodResponse(goals),
  });

  assert.equal(result.goalEventCount, goals.length);
  assert.equal(result.momentum, "built");

  const outputs = listLoopOutputsForSession(db, sessionId);
  const kinds = outputs.map((o) => o.kind).sort();
  // 2 capture candidates + recap + hud_score + crm_move_proposal + email_draft
  assert.equal(outputs.length, 6);
  assert.deepEqual(kinds, [
    "capture_candidate",
    "capture_candidate",
    "crm_move_proposal",
    "email_draft",
    "hud_score",
    "recap",
  ]);
  for (const output of outputs) {
    assert.equal(output.status, "candidate");
    assert.ok(output.ttl_at, "every candidate carries a TTL");
  }

  const session = db.prepare("SELECT momentum_read FROM sessions WHERE id = ?").get(sessionId);
  assert.equal(session.momentum_read, "built");

  const events = db
    .prepare("SELECT * FROM goal_events WHERE session_id = ? AND status = 'covered'")
    .all(sessionId);
  assert.equal(events.length, 1);
  assert.match(events[0].evidence, /kitchen table/);
  assert.equal(events[0].scored_by, "claude");
});

test("covered without evidence is downgraded to partial with a warning", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);
  const response = JSON.stringify({
    momentum_read: "mixed",
    goal_scores: [{ goal_id: goals[0].id, status: "covered", evidence: null }],
    recap: { part1: {}, part2: {} },
    capture_candidates: [],
    crm_move_proposal: null,
    email_draft: null,
  });

  const result = await runSynthesis(db, { sessionId, generate: async () => response });

  const covered = db
    .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE session_id = ? AND status = 'covered'")
    .get(sessionId);
  assert.equal(covered.n, 0, "no unexplained checkmarks");
  assert.ok(result.warnings.some((w) => /without evidence/.test(w)));
});

test("evidence not verbatim in the transcript is downgraded to partial", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);
  const response = JSON.stringify({
    momentum_read: "built",
    goal_scores: [
      {
        goal_id: goals[0].id,
        status: "covered",
        evidence: "a fabricated quote that was never said",
      },
    ],
    recap: { part1: {}, part2: {} },
    capture_candidates: [],
    crm_move_proposal: null,
    email_draft: null,
  });

  const result = await runSynthesis(db, { sessionId, generate: async () => response });

  const covered = db
    .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE session_id = ? AND status = 'covered'")
    .get(sessionId);
  assert.equal(covered.n, 0);
  assert.ok(result.warnings.some((w) => /not verbatim/.test(w)));
});

test("unknown goal ids are dropped; unscored goals recorded as missed", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);
  const response = JSON.stringify({
    momentum_read: "leaked",
    goal_scores: [{ goal_id: "not-a-real-goal", status: "covered", evidence: "whatever" }],
    recap: { part1: {}, part2: {} },
    capture_candidates: [],
    crm_move_proposal: null,
    email_draft: null,
  });

  const result = await runSynthesis(db, { sessionId, generate: async () => response });

  const events = db.prepare("SELECT * FROM goal_events WHERE session_id = ?").all(sessionId);
  assert.equal(events.length, goals.length, "every real goal gets exactly one event");
  assert.ok(events.every((e) => e.status === "missed"));
  assert.ok(result.warnings.some((w) => /unknown goal/.test(w)));
});

test("markdown-fenced JSON still parses", () => {
  const goals = [{ id: "g1", label: "Ops", kind: "bucket", satisfied_when: "x" }];
  const fenced =
    "```json\n" +
    JSON.stringify({ momentum_read: "built", goal_scores: [], capture_candidates: [] }) +
    "\n```";
  const parsed = parseSynthesisResponse(fenced, goals, "transcript text");
  assert.equal(parsed.momentum, "built");
});

test("null email/crm outputs are skipped, not written as empty rows", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);
  const response = JSON.stringify({
    momentum_read: "mixed",
    goal_scores: goals.map((g) => ({ goal_id: g.id, status: "missed", evidence: null })),
    recap: { part1: {}, part2: {} },
    capture_candidates: [],
    crm_move_proposal: null,
    email_draft: null,
  });

  await runSynthesis(db, { sessionId, generate: async () => response });
  const kinds = listLoopOutputsForSession(db, sessionId)
    .map((o) => o.kind)
    .sort();
  assert.deepEqual(kinds, ["hud_score", "recap"]);
});

test("loadSynthesisContext guards: no template, no transcript", () => {
  const db = openDb();
  const bareNoteId = Number(
    db.prepare("INSERT INTO notes (title) VALUES ('empty')").run().lastInsertRowid
  );
  const bareSession = createSession(db, { noteId: bareNoteId });
  assert.throws(() => loadSynthesisContext(db, bareSession), /no template attached/);

  const { sessionId } = setupSession(db, { transcript: "   " });
  assert.throws(() => loadSynthesisContext(db, sessionId), /no transcript or content/);
});

test("content is the fallback when transcript is empty", () => {
  const db = openDb();
  const noteId = Number(
    db
      .prepare(
        "INSERT INTO notes (title, content, transcript) VALUES ('n', 'typed note body', NULL)"
      )
      .run().lastInsertRowid
  );
  const template = db.prepare("SELECT * FROM templates LIMIT 1").get();
  const sessionId = createSession(db, { noteId, templateId: template.id });
  const ctx = loadSynthesisContext(db, sessionId);
  assert.equal(ctx.transcript, "typed note body");
});

test("computeHudScore reflects required goals from definition_of_done", () => {
  const goals = [
    { id: "a", ord: 1, label: "Ops", kind: "bucket" },
    { id: "b", ord: 2, label: "Pain", kind: "bucket" },
  ];
  const scores = [
    { goalId: "a", status: "covered", evidence: "q" },
    { goalId: "b", status: "partial", evidence: null },
  ];
  const hud = computeHudScore(scores, goals, { required_goals: [1, 2] });
  assert.equal(hud.covered, 1);
  assert.equal(hud.partial, 1);
  assert.equal(hud.required_met, false);
  const hud2 = computeHudScore(scores, goals, { required_goals: [1] });
  assert.equal(hud2.required_met, true);
});

test("prompt carries goals, shape, and transcript; nod-gate survives approval flow", async () => {
  const db = openDb();
  const { sessionId, goals } = setupSession(db);
  const ctx = loadSynthesisContext(db, sessionId);
  const { system, prompt } = buildSynthesisPrompt(ctx);
  assert.match(system, /VERBATIM/);
  assert.match(prompt, /GOALS TO SCORE/);
  assert.match(prompt, /kitchen table/);
  assert.ok(goals.every((g) => prompt.includes(g.id)));

  await runSynthesis(db, { sessionId, generate: async () => goodResponse(goals) });
  const outputs = listLoopOutputsForSession(db, sessionId);
  const approved = approveLoopOutput(db, outputs[0].id);
  assert.equal(approved.status, "approved");
  assert.throws(() => approveLoopOutput(db, outputs[0].id), /must be 'candidate'/);
});
