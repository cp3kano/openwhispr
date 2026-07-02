const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { isPortAvailable } = require("../utils/serverUtils");
const loopStore = require("./loopStore");

// Roomtone local MCP server — increment 5 (fork-spec build item 4).
//
// The MCP surface upstream advertises is their hosted Pro cloud; this is the
// local, no-cloud replacement grown out of the cliBridge pattern: loopback
// only, bearer token, discovery file on disk. Any MCP client on this machine
// (Claude Code, Claude Desktop via mcp-remote, scripts) can read the corpus
// and stage candidates.
//
// The permission line — the answer to the data model's open question:
//   READ everything. WRITE only candidates. NEVER decide.
// There is deliberately no approve/fade tool here. The nod belongs to the
// human in the app; a remote Claude session can propose, not promote.
//
// Protocol: MCP streamable-HTTP, JSON-RPC 2.0 over POST, plain-JSON replies.
// Hand-rolled on node http — no SDK dependency; the method surface a client
// needs (initialize, ping, tools/list, tools/call) is small and stable.

const PORT_RANGE_START = 8220;
const PORT_RANGE_END = 8239;
const HOST = "127.0.0.1";
const DISCOVERY_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "roomtone", version: "0.1.0" };
const MAX_TRANSCRIPT_CHARS = 120000;

function getDiscoveryFilePath() {
  return path.join(os.homedir(), ".openwhispr", "roomtone-mcp.json");
}

// ---------------------------------------------------------------------------
// Tools — pure functions over the better-sqlite3 handle, testable without HTTP.

function ftsEscape(query) {
  return String(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, "")}"`)
    .join(" ");
}

function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated: ${s.length - max} more characters]`;
}

function searchNotes(db, { query, limit = 10 } = {}) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
  try {
    return db
      .prepare(
        `SELECT n.id, n.title, n.created_at,
                snippet(notes_fts, 1, '[', ']', ' … ', 12) AS snippet,
                (n.transcript IS NOT NULL AND n.transcript != '') AS has_transcript
         FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
         ORDER BY rank LIMIT ?`
      )
      .all(ftsEscape(query), cap);
  } catch (err) {
    debugLogger.debug("FTS search failed; falling back to LIKE", { error: err.message });
    const like = `%${String(query).trim()}%`;
    return db
      .prepare(
        `SELECT id, title, created_at,
                substr(COALESCE(NULLIF(transcript, ''), content), 1, 200) AS snippet,
                (transcript IS NOT NULL AND transcript != '') AS has_transcript
         FROM notes
         WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ? OR transcript LIKE ?)
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, like, like, cap);
  }
}

function getNote(db, { note_id } = {}) {
  const id = Number(note_id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("note_id must be a positive integer");
  const note = db
    .prepare(
      `SELECT id, title, content, transcript, participants, created_at, updated_at
       FROM notes WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id);
  if (!note) throw new Error(`Note not found: ${id}`);
  return {
    ...note,
    content: truncate(note.content, MAX_TRANSCRIPT_CHARS),
    transcript: truncate(note.transcript, MAX_TRANSCRIPT_CHARS),
    session: loopStore.getSessionForNote(db, id),
  };
}

function listSessions(db, { limit = 20 } = {}) {
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

function getSessionDetail(db, { session_id } = {}) {
  if (!session_id) throw new Error("session_id is required");
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session_id);
  if (!session) throw new Error(`Session not found: ${session_id}`);
  const goalEvents = db
    .prepare(
      `SELECT e.status, e.evidence, e.scored_by, g.label, g.kind, g.ord
       FROM goal_events e JOIN template_goals g ON g.id = e.goal_id
       WHERE e.session_id = ? ORDER BY g.ord`
    )
    .all(session_id);
  return {
    session,
    goal_events: goalEvents,
    outputs: loopStore.listLoopOutputsForSession(db, session_id),
  };
}

function listPendingCandidates(db, { limit = 50 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(
      `SELECT o.id, o.session_id, o.kind, o.content, o.destination, o.ttl_at, o.created_at,
              n.title AS note_title
       FROM loop_outputs o
       JOIN sessions s ON s.id = o.session_id
       LEFT JOIN notes n ON n.id = s.note_id
       WHERE o.status = 'candidate'
       ORDER BY o.created_at DESC LIMIT ?`
    )
    .all(cap);
}

function listTemplates(db) {
  return loopStore.listTemplates(db);
}

const OUTPUT_KINDS = new Set([
  "recap",
  "hud_score",
  "capture_candidate",
  "crm_move_proposal",
  "email_draft",
  "insight",
]);

// The one write. Always lands as status='candidate' — createLoopOutput cannot
// produce anything else, and no tool on this surface can change a status.
function createLoopOutputTool(db, { session_id, kind, content, destination } = {}) {
  if (!session_id) throw new Error("session_id is required");
  if (!OUTPUT_KINDS.has(kind)) {
    throw new Error(`kind must be one of: ${[...OUTPUT_KINDS].join(", ")}`);
  }
  if (content == null || content === "") throw new Error("content is required");
  const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session_id);
  if (!session) throw new Error(`Session not found: ${session_id}`);
  const id = loopStore.createLoopOutput(db, {
    sessionId: session_id,
    kind,
    content,
    destination: destination || null,
  });
  const row = db
    .prepare("SELECT id, session_id, kind, status FROM loop_outputs WHERE id = ?")
    .get(id);
  return { created: row };
}

const TOOL_DEFINITIONS = [
  {
    name: "search_notes",
    description:
      "Full-text search across all notes and meeting transcripts. Returns id, title, snippet, and whether a transcript exists.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        limit: { type: "integer", description: "Max results (default 10, max 50)" },
      },
      required: ["query"],
    },
    handler: searchNotes,
  },
  {
    name: "get_note",
    description:
      "Fetch one note in full: content, transcript (may be truncated past 120k chars), participants, and its loop session if one exists.",
    inputSchema: {
      type: "object",
      properties: { note_id: { type: "integer", description: "Note id from search_notes" } },
      required: ["note_id"],
    },
    handler: getNote,
  },
  {
    name: "list_sessions",
    description:
      "List loop sessions newest first: template, engagement, momentum read, and pending candidate count per session.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results (default 20, max 100)" } },
    },
    handler: listSessions,
  },
  {
    name: "get_session_detail",
    description:
      "Everything about one session: the row, goal events with evidence, and every loop output regardless of status.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session id (uuid)" } },
      required: ["session_id"],
    },
    handler: getSessionDetail,
  },
  {
    name: "list_pending_candidates",
    description:
      "The nod queue: every loop output still in status=candidate across all sessions, newest first, with its note title.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results (default 50, max 200)" } },
    },
    handler: listPendingCandidates,
  },
  {
    name: "list_templates",
    description: "List loop templates with version, status, reuse count, and goal count.",
    inputSchema: { type: "object", properties: {} },
    handler: listTemplates,
  },
  {
    name: "create_loop_output",
    description:
      "Stage a new loop output. It ALWAYS lands as status=candidate — approval only happens in the app, by the human. Kinds: recap, hud_score, capture_candidate, crm_move_proposal, email_draft, insight.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session to attach the output to" },
        kind: { type: "string", description: "One of the six output kinds" },
        content: { type: "string", description: "The artifact (text or JSON string)" },
        destination: { type: "string", description: "Optional destination hint" },
      },
      required: ["session_id", "kind", "content"],
    },
    handler: createLoopOutputTool,
  },
];

function listToolDefinitions() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function callTool(db, name, args) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(db, args || {});
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP method dispatch. Returns null for notifications (no reply).

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function handleMcpMessage(db, message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message && message.id, -32600, "Invalid JSON-RPC request");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listToolDefinitions() });
      case "tools/call": {
        const name = params?.name;
        try {
          const result = callTool(db, name, params?.arguments);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          // Tool-level failures are results with isError, not protocol errors.
          return rpcResult(id, {
            content: [{ type: "text", text: err.message }],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, err.message || "Internal error");
  }
}

// ---------------------------------------------------------------------------
// HTTP server — the cliBridge chassis: loopback only, bearer token,
// discovery file at ~/.openwhispr/roomtone-mcp.json (mode 0600).

class RoomtoneMcpServer {
  // getDb is a function so the server survives database re-opens.
  constructor(getDb) {
    this.getDb = getDb;
    this.server = null;
    this.port = null;
    this.token = null;
    this.discoveryFilePath = getDiscoveryFilePath();
  }

  async start() {
    if (this.server) return;
    this.token = crypto.randomBytes(32).toString("hex");

    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) {
        this.port = port;
        break;
      }
    }
    if (!this.port) {
      throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
    }

    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("Roomtone MCP handler error", { error: err.message }, "roomtone-mcp");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rpcError(null, -32603, "Internal server error")));
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeDiscoveryFile();
    debugLogger.info("Roomtone MCP server started", { port: this.port }, "roomtone-mcp");
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.port = null;
    this.token = null;
    try {
      fs.unlinkSync(this.discoveryFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("MCP discovery file removal failed", { error: err.message });
      }
    }
    debugLogger.info("Roomtone MCP server stopped", {}, "roomtone-mcp");
  }

  url() {
    return this.port ? `http://${HOST}:${this.port}/mcp` : null;
  }

  _writeDiscoveryFile() {
    fs.mkdirSync(path.dirname(this.discoveryFilePath), { recursive: true });
    fs.writeFileSync(
      this.discoveryFilePath,
      JSON.stringify({
        version: DISCOVERY_FILE_VERSION,
        url: this.url(),
        token: this.token,
      }),
      { mode: 0o600 }
    );
    try {
      fs.chmodSync(this.discoveryFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("MCP discovery chmod failed", { error: err.message });
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      res.writeHead(403).end();
      return;
    }

    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32000, "Unauthorized")));
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      // No server-initiated stream in v0; clients fall back to plain POST.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    let raw = "";
    let tooLarge = false;
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > MAX_REQUEST_BODY_BYTES) {
          tooLarge = true;
          req.destroy();
          resolve();
        }
      });
      req.on("end", resolve);
      req.on("error", reject);
    });
    if (tooLarge) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
      return;
    }

    const db = this.getDb();
    if (!db) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rpcError(message?.id, -32603, "Database not ready")));
      return;
    }

    const reply = Array.isArray(message)
      ? message.map((m) => handleMcpMessage(db, m)).filter(Boolean)
      : handleMcpMessage(db, message);

    if (reply === null || (Array.isArray(reply) && reply.length === 0)) {
      res.writeHead(202).end();
      return;
    }
    const body = JSON.stringify(reply);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

module.exports = {
  RoomtoneMcpServer,
  handleMcpMessage,
  listToolDefinitions,
  callTool,
  searchNotes,
  getNote,
  listSessions,
  getSessionDetail,
  listPendingCandidates,
  createLoopOutputTool,
  getDiscoveryFilePath,
  PROTOCOL_VERSION,
};
