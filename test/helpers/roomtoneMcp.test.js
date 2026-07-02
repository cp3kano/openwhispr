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
  createLoopOutput,
  approveLoopOutput,
} = require("../../src/helpers/loopStore");

const {
  RoomtoneMcpServer,
  handleMcpMessage,
  listToolDefinitions,
  searchNotes,
  getNote,
  listPendingCandidates,
  createLoopOutputTool,
} = require("../../src/helpers/roomtoneMcp");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "docs", "roomtone", "templates");

// Mirror of the upstream columns the MCP tools read, plus the FTS table the
// real database ships so search goes through the FTS path in tests too.
const NOTES_FIXTURE = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled Note',
    content TEXT NOT NULL DEFAULT '',
    enhanced_content TEXT,
    transcript TEXT,
    participants TEXT,
    deleted_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, enhanced_content, content=notes, content_rowid=id
  );
  CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content, enhanced_content)
    VALUES (new.id, new.title, new.content, new.enhanced_content);
  END;
`;

const openDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roomtone-mcp-test-"));
  const db = new Database(path.join(dir, "mcp.db"));
  db.exec(NOTES_FIXTURE);
  initLoopStoreSchema(db);
  seedDefaultTemplates(db, TEMPLATES_DIR);
  return db;
};

const seedNote = (db, { title = "Josh discovery", content = "", transcript = null } = {}) =>
  Number(
    db
      .prepare("INSERT INTO notes (title, content, transcript) VALUES (?, ?, ?)")
      .run(title, content, transcript).lastInsertRowid
  );

test("tool layer: search finds notes via FTS, get_note returns transcript + session", () => {
  const db = openDb();
  const noteId = seedNote(db, {
    title: "Kitchen table estimating",
    content: "The whole estimating process happens at the kitchen table",
    transcript: "Josh: the whole estimating process is me at the kitchen table",
  });
  const template = db.prepare("SELECT id FROM templates LIMIT 1").get();
  createSession(db, { noteId, templateId: template.id });

  const hits = searchNotes(db, { query: "kitchen estimating" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, noteId);
  assert.equal(Boolean(hits[0].has_transcript), true);

  const note = getNote(db, { note_id: noteId });
  assert.match(note.transcript, /kitchen table/);
  assert.ok(note.session, "session rides along");
  assert.equal(note.session.template_id, template.id);
});

test("tool layer: write is candidate-only and no approve tool exists", () => {
  const db = openDb();
  const template = db.prepare("SELECT id FROM templates LIMIT 1").get();
  const sessionId = createSession(db, { templateId: template.id });

  const { created } = createLoopOutputTool(db, {
    session_id: sessionId,
    kind: "insight",
    content: "clients repeat the kitchen-table pattern",
  });
  assert.equal(created.status, "candidate");

  const toolNames = listToolDefinitions().map((t) => t.name);
  assert.ok(
    !toolNames.some((n) => /approve|fade|commit|decide/.test(n)),
    "no decision-making tool is exposed over MCP"
  );

  assert.throws(
    () => createLoopOutputTool(db, { session_id: sessionId, kind: "verdict", content: "x" }),
    /kind must be one of/
  );
  assert.throws(
    () => createLoopOutputTool(db, { session_id: "nope", kind: "insight", content: "x" }),
    /Session not found/
  );
});

test("tool layer: pending candidates excludes approved outputs", () => {
  const db = openDb();
  const template = db.prepare("SELECT id FROM templates LIMIT 1").get();
  const sessionId = createSession(db, { templateId: template.id });
  const keep = createLoopOutput(db, { sessionId, kind: "insight", content: "pending one" });
  const done = createLoopOutput(db, { sessionId, kind: "insight", content: "approved one" });
  approveLoopOutput(db, done);

  const pending = listPendingCandidates(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, keep);
});

test("protocol: initialize, tools/list, tools/call, ping, notifications, unknown method", () => {
  const db = openDb();

  const init = handleMcpMessage(db, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  assert.equal(init.result.serverInfo.name, "roomtone");
  assert.ok(init.result.capabilities.tools);

  assert.equal(handleMcpMessage(db, { jsonrpc: "2.0", method: "notifications/initialized" }), null);

  const list = handleMcpMessage(db, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.result.tools.length, 7);

  const ping = handleMcpMessage(db, { jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});

  const bad = handleMcpMessage(db, { jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal(bad.error.code, -32601);

  const failedCall = handleMcpMessage(db, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "get_note", arguments: { note_id: 99999 } },
  });
  assert.equal(failedCall.result.isError, true);
});

test("http: full round trip with auth; bad token rejected; GET is 405", async () => {
  const db = openDb();
  const noteId = seedNote(db, { title: "HTTP note", content: "reachable over http" });
  const server = new RoomtoneMcpServer(() => db);
  // Point the discovery file at a temp location so the test never touches ~/.openwhispr
  server.discoveryFilePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "roomtone-mcp-disc-")),
    "roomtone-mcp.json"
  );
  await server.start();
  try {
    const url = server.url();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${server.token}`,
    };

    const disc = JSON.parse(fs.readFileSync(server.discoveryFilePath, "utf8"));
    assert.equal(disc.url, url);
    assert.equal(disc.token, server.token);

    const initRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(initRes.status, 200);
    assert.equal((await initRes.json()).result.serverInfo.name, "roomtone");

    const callRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_note", arguments: { note_id: noteId } },
      }),
    });
    const callBody = await callRes.json();
    assert.match(callBody.result.content[0].text, /reachable over http/);

    const noteRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(noteRes.status, 202);

    const badAuth = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    });
    assert.equal(badAuth.status, 401);

    const get = await fetch(url, { method: "GET", headers });
    assert.equal(get.status, 405);
  } finally {
    await server.stop();
  }
  assert.equal(fs.existsSync(server.discoveryFilePath), false, "discovery file removed on stop");
});
