# Roomtone — Template Object Data Model (Architect, v1)

The template is the DNA: one object, four jobs (notes out, live goals, definition of done, deploy spec). All tables are additive beside upstream's `notes` — no surgery on their schema. SQLite via the existing better-sqlite3/kysely stack. DDL: `loop-store.sql`.

## Entities

**`templates`** — the library. Sharable, versioned, self-tuning. Key fields: `output_format` (json — the recap shape), `definition_of_done` (json, machine-readable), `deploy_spec` (json, ordered outputs), `status` (draft · validated · productized), `reuse_count` (ticks every run — the productize signal).

**`template_goals`** — the checkable goal set, separate because goals are what the HUD matches and what tuning re-weights. `kind` = `bucket` (topic coverage) or `behavior` (live conduct). `satisfied_when` is the plain-language matcher criterion; embeddings derive from it. `value_score` starts at 1.0 and moves with feedback. `ord` is display order — buckets are a net, not a railroad.

**`sessions`** — one capture event. Quick Note and Templated Session are the same row; the difference is whether `template_id` is null at start. Retroactive promotion = set `template_id` + run the retro scorer. `note_id` bridges to upstream's transcript/diarization world. Nothing in the capture path reads this table — capture is never gated.

**`goal_events`** — what the scorer decided, with receipts. `status` covered/partial/missed, `evidence` = the transcript span that satisfied it, `scored_by` = retro · live_matcher · claude.

**`loop_outputs`** — everything the deploy spec produces. This IS the local nod queue: `status` candidate → approved → committed (or faded via `ttl_at`). `kind` ∈ recap · hud_score · capture_candidate · crm_move_proposal · email_draft · insight.

**`tuning_events`** — the self-tuning memory. `signal` ∈ kept · redone · cut · nudge_wanted, plus Cory's why, verbatim. Three matching signals on the same goal/output = tuning trigger → draft a template version bump (as a candidate).

## Invariants (enforce in code, not vibes)

1. No external write unless `loop_outputs.status = 'approved'` — the nod-gate is a schema fact.
2. `goal_events.evidence` NOT NULL when `status = 'covered'` — no unexplained checkmarks.
3. Template versions are immutable once run against — tuning creates a new version.
4. Nothing biometric enters the loop store; voiceprints stay in upstream's tables, local-only.

## Open questions

- `output_format` as JSON vs normalized recap-section table: start JSON, normalize when it hurts.
- MCP permission line: read-everything / write-only-candidates seems right and matches the nod-gate. [NEEDS INPUT from Cory before the MCP server ships.]
