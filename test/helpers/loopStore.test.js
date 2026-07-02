const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Database = require("better-sqlite3");

const {
  initLoopStoreSchema,
  createTemplate,
  createSession,
  attachTemplateToSession,
  listTemplates,
  getSessionForNote,
  attachTemplateToNote,
  listLoopOutputsForSession,
  recordGoalEvent,
  createLoopOutput,
  approveLoopOutput,
  fadeLoopOutput,
  recordTuningEvent,
  seedDefaultTemplates,
} = require("../../src/helpers/loopStore");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "docs", "roomtone", "templates");

const openTempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-store-test-"));
  const db = new Database(path.join(dir, "loop-store.db"));
  initLoopStoreSchema(db);
  return db;
};

test("schema init is idempotent", () => {
  const db = openTempDb();
  initLoopStoreSchema(db);
  initLoopStoreSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const t of [
    "templates",
    "template_goals",
    "sessions",
    "goal_events",
    "loop_outputs",
    "tuning_events",
  ]) {
    assert.ok(tables.includes(t), `missing table: ${t}`);
  }
  db.close();
});

test("seeding the Common Cause template yields 1 template and 6 goals, idempotently", () => {
  const db = openTempDb();
  const first = seedDefaultTemplates(db, TEMPLATES_DIR);
  assert.equal(first.length, 1);
  assert.equal(first[0].created, true);

  // Second seed finds it already present
  const second = seedDefaultTemplates(db, TEMPLATES_DIR);
  assert.equal(second[0].created, false);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM templates").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM template_goals").get().n, 6);

  const template = db.prepare("SELECT * FROM templates").get();
  assert.equal(template.name, "Common Cause Client Conversation");
  assert.equal(template.version, 1);
  assert.equal(template.status, "draft");
  // JSON round-trips
  assert.equal(JSON.parse(template.deploy_spec).length, 5);
  assert.deepEqual(JSON.parse(template.definition_of_done).required_goals, [1, 2, 3, 4]);
  db.close();
});

test("invariant: goal_event covered without evidence throws", () => {
  const db = openTempDb();
  const [seed] = seedDefaultTemplates(db, TEMPLATES_DIR);
  const goal = db
    .prepare("SELECT id FROM template_goals WHERE template_id = ? AND ord = 1")
    .get(seed.id);
  const sessionId = createSession(db, { templateId: seed.id, engagement: "Hammer Stars" });

  assert.throws(
    () =>
      recordGoalEvent(db, {
        sessionId,
        goalId: goal.id,
        status: "covered",
        evidence: null,
        scoredBy: "retro",
      }),
    /CHECK constraint failed/
  );

  // covered WITH evidence is fine
  recordGoalEvent(db, {
    sessionId,
    goalId: goal.id,
    status: "covered",
    evidence: "walked me through the take-off workflow end to end",
    scoredBy: "retro",
  });
  // missed with no evidence is fine
  recordGoalEvent(db, { sessionId, goalId: goal.id, status: "missed", scoredBy: "live_matcher" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM goal_events").get().n, 2);

  // bogus status is rejected by the schema
  assert.throws(
    () =>
      recordGoalEvent(db, {
        sessionId,
        goalId: goal.id,
        status: "kinda",
        evidence: "x",
        scoredBy: "retro",
      }),
    /CHECK constraint failed/
  );
  db.close();
});

test("loop_outputs lifecycle: candidate -> approved; bogus status throws", () => {
  const db = openTempDb();
  const sessionId = createSession(db);
  const outputId = createLoopOutput(db, {
    sessionId,
    kind: "recap",
    content: { how_it_went: "built" },
    destination: "file",
  });

  const before = db
    .prepare("SELECT status, decided_at FROM loop_outputs WHERE id = ?")
    .get(outputId);
  assert.equal(before.status, "candidate");
  assert.equal(before.decided_at, null);

  const approved = approveLoopOutput(db, outputId);
  assert.equal(approved.status, "approved");
  assert.ok(approved.decided_at);

  // approving a non-candidate throws
  assert.throws(() => approveLoopOutput(db, outputId), /must be 'candidate'/);

  // unknown id throws
  assert.throws(() => approveLoopOutput(db, "nope"), /not found/);

  // bogus status rejected by the schema
  assert.throws(
    () => db.prepare("UPDATE loop_outputs SET status = 'shipped' WHERE id = ?").run(outputId),
    /CHECK constraint failed/
  );
  assert.throws(
    () => createLoopOutput(db, { sessionId, kind: "press_release", content: "no such kind" }),
    /CHECK constraint failed/
  );
  db.close();
});

test("retroactive promotion: quick note session attaches a template after the fact", () => {
  const db = openTempDb();
  const [seed] = seedDefaultTemplates(db, TEMPLATES_DIR);

  // Quick Note: no template at start
  const sessionId = createSession(db, { engagement: "walk-in" });
  const bare = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  assert.equal(bare.template_id, null);
  assert.equal(bare.template_version, null);

  const promoted = attachTemplateToSession(db, sessionId, seed.id);
  assert.equal(promoted.template_id, seed.id);
  assert.equal(promoted.template_version, 1); // pinned at attach time

  // reuse_count ticked
  assert.equal(
    db.prepare("SELECT reuse_count FROM templates WHERE id = ?").get(seed.id).reuse_count,
    1
  );

  // unknown session / template throw
  assert.throws(() => attachTemplateToSession(db, "nope", seed.id), /Session not found/);
  assert.throws(() => attachTemplateToSession(db, sessionId, "nope"), /Template not found/);
  db.close();
});

test("createTemplate is idempotent on (name, version) and tuning events record", () => {
  const db = openTempDb();
  const spec = {
    name: "Test Template",
    version: 1,
    output_format: { shape: "test" },
    definition_of_done: {},
    deploy_spec: [],
    goals: [{ ord: 1, label: "One", kind: "bucket", satisfied_when: "always" }],
  };
  const first = createTemplate(db, spec);
  assert.equal(first.created, true);
  const again = createTemplate(db, spec);
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);

  const sessionId = createSession(db, { templateId: first.id });
  const outputId = createLoopOutput(db, { sessionId, kind: "insight", content: "keep" });
  recordTuningEvent(db, { sessionId, outputId, signal: "kept", note: "exactly right" });
  assert.throws(
    () => recordTuningEvent(db, { sessionId, outputId, signal: "meh" }),
    /CHECK constraint failed/
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tuning_events").get().n, 1);
  db.close();
});

test("one-call promotion: attachTemplateToNote creates the session when none exists", () => {
  const db = openTempDb();
  const [seed] = seedDefaultTemplates(db, TEMPLATES_DIR);

  // No session yet for note 42 — the UI's single call must create and attach.
  assert.equal(getSessionForNote(db, 42), null);
  const session = attachTemplateToNote(db, 42, seed.id);
  assert.equal(session.note_id, 42);
  assert.equal(session.template_id, seed.id);
  assert.equal(session.template_version, 1);

  // Exactly one session, reuse_count ticked exactly once.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE note_id = 42").get().n, 1);
  assert.equal(
    db.prepare("SELECT reuse_count FROM templates WHERE id = ?").get(seed.id).reuse_count,
    1
  );

  // getSessionForNote now finds it, with the template name joined in.
  const found = getSessionForNote(db, 42);
  assert.equal(found.id, session.id);
  assert.equal(found.template_name, "Common Cause Client Conversation");
  db.close();
});

test("one-call promotion: attachTemplateToNote reuses an existing bare session", () => {
  const db = openTempDb();
  const [seed] = seedDefaultTemplates(db, TEMPLATES_DIR);

  // A bare Quick Note session already exists (capture was never gated).
  const bareId = createSession(db, { noteId: 7 });
  assert.equal(getSessionForNote(db, 7).template_id, null);

  const session = attachTemplateToNote(db, 7, seed.id);
  assert.equal(session.id, bareId, "must promote the existing session, not create a second one");
  assert.equal(session.template_id, seed.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE note_id = 7").get().n, 1);
  assert.equal(
    db.prepare("SELECT reuse_count FROM templates WHERE id = ?").get(seed.id).reuse_count,
    1
  );

  // Unknown template rolls back cleanly and changes nothing.
  assert.throws(() => attachTemplateToNote(db, 7, "no-such-template"), /Template not found/);
  assert.equal(getSessionForNote(db, 7).template_id, seed.id);
  db.close();
});

test("read side: listTemplates carries goal_count; listLoopOutputsForSession scopes to the session", () => {
  const db = openTempDb();
  const [seed] = seedDefaultTemplates(db, TEMPLATES_DIR);
  createTemplate(db, {
    name: "Bare Minimum",
    goals: [{ ord: 1, label: "show up", kind: "behavior", satisfied_when: "present" }],
  });

  const templates = listTemplates(db);
  assert.equal(templates.length, 2);
  const byName = Object.fromEntries(templates.map((t) => [t.name, t]));
  assert.equal(byName["Common Cause Client Conversation"].goal_count, 6);
  assert.equal(byName["Bare Minimum"].goal_count, 1);
  assert.equal(byName["Bare Minimum"].status, "draft");

  const sessionA = attachTemplateToNote(db, 1, seed.id).id;
  const sessionB = createSession(db, { noteId: 2 });
  const outA = createLoopOutput(db, { sessionId: sessionA, kind: "recap", content: "a" });
  createLoopOutput(db, { sessionId: sessionB, kind: "insight", content: "b" });

  const outputs = listLoopOutputsForSession(db, sessionA);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].id, outA);
  assert.equal(outputs[0].status, "candidate");
  db.close();
});

test("fade lifecycle: candidate -> faded; approved cannot fade; faded cannot approve", () => {
  const db = openTempDb();
  seedDefaultTemplates(db, TEMPLATES_DIR);
  const template = db.prepare("SELECT id FROM templates LIMIT 1").get();
  const sessionId = createSession(db, { templateId: template.id });

  const fadeable = createLoopOutput(db, { sessionId, kind: "insight", content: "let this one go" });
  const faded = fadeLoopOutput(db, fadeable);
  assert.equal(faded.status, "faded");
  assert.ok(faded.decided_at, "an explicit no is a decision — it gets a timestamp");
  assert.throws(() => approveLoopOutput(db, fadeable), /must be 'candidate'/);
  assert.throws(() => fadeLoopOutput(db, fadeable), /must be 'candidate'/);

  const kept = createLoopOutput(db, { sessionId, kind: "insight", content: "keep this one" });
  approveLoopOutput(db, kept);
  assert.throws(() => fadeLoopOutput(db, kept), /must be 'candidate'/);

  assert.throws(() => fadeLoopOutput(db, "nonexistent-id"), /not found/);
});
