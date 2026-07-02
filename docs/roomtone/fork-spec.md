# Roomtone — Fork Spec (Architect, v1)

Written 2026-07-01, grounded in recon of upstream `OpenWhispr/openwhispr` @ v1.7.3 (commit fd818bd) — the exact commit this fork was cut from. Companion doc: `data-model.md`.

## What recon changed

The original plan assumed we were forking a dictation app and building the meeting layer. Wrong, in a good way: upstream already positions itself as a Granola alternative and ships most of the capture machinery. What we assumed we'd inherit (MCP server, public API) is actually their hosted paid cloud. So the fork inverts: **keep the capture stack nearly whole, cut the cloud tendrils, build the loop + local MCP as net-new.**

## Keep (don't touch until it fights us)

- Capture, both lanes: mic (MediaRecorder) + system audio (`src/helpers/audioTapManager.js` on macOS, `linuxPortalAudioManager.js` on Linux), WebRTC AEC sidecar (`native/meeting-aec-helper/`, `meetingAecManager.js`).
- ASR: whisper.cpp + Parakeet (sherpa-onnx) local; Deepgram/AssemblyAI/OpenAI streaming helpers.
- Diarization + speakers: `diarization.js`, `speakerEmbeddings.js`, `liveSpeakerIdentifier.js`, `speakerAssignmentPolicy.js`. Voiceprints stay local-only and opt-in — verify the fingerprint store never syncs.
- Meeting detection: `meetingDetectionEngine.js` + detectors, Google Calendar sync.
- Store + search: better-sqlite3/kysely, FTS5 + Qdrant hybrid, local MiniLM embeddings. The `notes` table already carries `participants`, `diarization_enabled`, `expected_speaker_count`.
- LLM plumbing: Vercel AI SDK, Anthropic provider = BYO-key Claude already wired.
- `cliBridge.js` (loopback HTTP 127.0.0.1:8200–8219, bearer auth) — seed for the local API/MCP.
- The dictation flow itself. It's upstream's spine; ignore rather than remove.
- Upstream `CLAUDE.md` — keep and amend.

## Cut or stub

- OpenWhispr Cloud sync (Neon), `better-auth`, Pro entitlement gating.
- Hosted-MCP card (`src/components/McpIntegrationCard.tsx` → hardcodes mcp.openwhispr.com) — replaced by the local MCP server, not just deleted.
- Pro/plan strings — live in **all 10 locale files**; cutting touches every locale or the UI lies in nine languages.
- Sidecar download endpoints point at OpenWhispr's releases — fine for dev; re-point before any distribution.

## Build (Phase 1, in order)

1. **Loop store** — `loop-store.sql` wired into `src/helpers/database.js`'s migration path. New tables only.
2. **Ungated Quick Note + template attach** — retroactive promotion is a data operation, never a capture-path change.
3. **Post-meeting synthesis** — Claude runs the attached template's deploy spec against the transcript: recap, capture candidates, email draft. All candidates, all nod-gated.
4. **Local MCP server** — net-new, grown from the `cliBridge.js` pattern. Read-everything / write-only-candidates permission line (open question, see data-model).
5. **Daily companion v0** — read-only view: open threads, patterns, what to prep.

Not Phase 1: mobile, live HUD, connector pushes (Notion/JobTread/CRM). Loop outputs land as local drafts until Phase 4.

## Known risks

- Sidecar zoo (~8 per-platform binaries via `sidecarRegistry.js`): change nothing in that layer in Phase 1.
- Long recordings unverified: diarization jobs have a 5-min timeout; `conversationChunker.js` suggests chunking. **First hands-on test: a 90-minute recording.**
- Windows system audio unverified (dev machine is macOS; park it).
- Upstream is active (4.2k stars): stay additive so merges stay cheap.

## Phase 1 definition of done

A real client call recorded (system audio or room mic) produces the two-part recap + capture candidates + email draft in Cory's voice as nod-gated candidates, and the daily companion shows open threads — all local, all on his key.
