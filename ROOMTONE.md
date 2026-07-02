# Roomtone (working name)

This fork turns OpenWhispr into a meeting companion wired to a capture → classify → curate → deploy loop. Upstream's capture stack (system audio + AEC, diarization, meeting detection, local ASR) stays whole; the cloud/Pro tendrils get cut; the loop store, template object, and a local MCP server are net-new.

Start here:

- `docs/roomtone/fork-spec.md` — what we keep, cut, and build, grounded in recon of v1.7.3 (fd818bd)
- `docs/roomtone/data-model.md` — the template object and loop store
- `docs/roomtone/loop-store.sql` — the schema as DDL (not yet wired into src/helpers/database.js — that's the first coding session)
- `docs/roomtone/templates/common-cause-client-conversation.json` — the first template, seed data

Ground rules for any session working in this repo:

1. Capture is never gated. Nothing may add setup friction to starting a recording.
2. Every loop output drafts as a candidate. Nothing writes externally unless approved (`loop_outputs.status = 'approved'`). The nod-gate is a schema fact, not a convention.
3. Additive over invasive. New modules and new tables beside upstream's, so upstream merges stay cheap.
4. Voiceprint/speaker data stays local-only and opt-in. Nothing biometric leaves the machine or enters the loop store.
5. If a feature doesn't feed the loop or the (future) live HUD, it waits.

Upstream's `CLAUDE.md` is the architecture map for the inherited code — read it before touching `src/helpers/`.

## Connecting a Claude client (increment 6)

The app runs a local MCP server (`src/helpers/roomtoneMcp.js`); `scripts/roomtone-mcp-bridge.js`
is the stdio bridge for clients that can't speak HTTP directly. It re-reads
`~/.openwhispr/roomtone-mcp.json` on every request, so it survives app restarts
(rotating token, shifting port) with zero config maintenance.

Claude Desktop (`claude_desktop_config.json`):
    "roomtone": { "command": "node", "args": ["<repo>/scripts/roomtone-mcp-bridge.js"] }

Claude Code:
    claude mcp add roomtone -- node <repo>/scripts/roomtone-mcp-bridge.js
