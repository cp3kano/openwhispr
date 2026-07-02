#!/usr/bin/env node
// Roomtone MCP stdio bridge.
//
// Claude Desktop (and any stdio-only MCP client) spawns this script; it
// proxies newline-delimited JSON-RPC from stdio to the Roomtone MCP server
// running inside the OpenWhispr app. The token rotates and the port can
// shift on every app launch, so the bridge re-reads the discovery file at
// ~/.openwhispr/roomtone-mcp.json on EVERY request — wiring stays valid
// across app restarts in both directions, no config edits ever needed.
//
// Zero dependencies. Usage in claude_desktop_config.json:
//   "roomtone": { "command": "node", "args": ["<path>/scripts/roomtone-mcp-bridge.js"] }

const fs = require("fs");
const os = require("os");
const path = require("path");

const DISCOVERY_FILE = path.join(os.homedir(), ".openwhispr", "roomtone-mcp.json");

function readDiscovery() {
  const raw = fs.readFileSync(DISCOVERY_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.url || !parsed.token) throw new Error("Discovery file is incomplete");
  return parsed;
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function forward(message) {
  let discovery;
  try {
    discovery = readDiscovery();
  } catch {
    return rpcError(
      message.id,
      -32001,
      "Roomtone is not reachable — is the OpenWhispr app running? (no discovery file at ~/.openwhispr/roomtone-mcp.json)"
    );
  }

  let res;
  try {
    res = await fetch(discovery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${discovery.token}`,
      },
      body: JSON.stringify(message),
    });
  } catch {
    return rpcError(
      message.id,
      -32001,
      "Roomtone is not reachable — the app may have just closed. Start OpenWhispr and try again."
    );
  }

  if (res.status === 202) return null; // notification accepted, nothing to relay
  if (res.status === 401) {
    // Stale token mid-flight (app restarted between file read and request) —
    // one retry with a fresh read covers it.
    try {
      const fresh = readDiscovery();
      const retry = await fetch(fresh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fresh.token}`,
        },
        body: JSON.stringify(message),
      });
      if (retry.status === 202) return null;
      if (retry.ok) return await retry.json();
    } catch {
      // fall through
    }
    return rpcError(message.id, -32001, "Roomtone rejected the token — restart the bridge client");
  }
  if (!res.ok) {
    return rpcError(message.id, -32603, `Roomtone returned HTTP ${res.status}`);
  }
  return await res.json();
}

let buffer = "";
let queue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeLine(rpcError(null, -32700, "Parse error"));
      continue;
    }
    // Serialize responses so stdout ordering matches request ordering.
    queue = queue.then(async () => {
      const reply = await forward(message);
      if (reply !== null && reply !== undefined) writeLine(reply);
    });
  }
});

process.stdin.on("end", () => {
  // Drain in-flight requests before exiting so piped usage works too.
  queue.then(() => process.exit(0));
});
