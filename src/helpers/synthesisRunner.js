const { recordGoalEvent, createLoopOutput } = require("./loopStore");

// Roomtone post-meeting synthesis — increment 3.
//
// Takes a finished session (note transcript + attached template), runs the
// template through Claude (BYO key), and lands every artifact as a
// status='candidate' row in loop_outputs. This module NEVER writes to any
// external destination — the nod-gate stays a schema fact (see loopStore.js).
//
// Pure module: better-sqlite3 handle + an injected async `generate` fn,
// no Electron imports, so it tests with `node --test` beside loopStore.js.
// The production `generate` comes from createClaudeGenerate() below.

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 180000;

const GOAL_STATUSES = new Set(["covered", "partial", "missed"]);
const MOMENTUM_READS = new Set(["built", "leaked", "mixed"]);

// ---------------------------------------------------------------------------
// Context loading

function loadSynthesisContext(db, sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.template_id) {
    throw new Error("Session has no template attached — attach one before synthesis");
  }
  if (session.note_id == null) {
    throw new Error("Session has no note — nothing to synthesize");
  }

  const template = db.prepare("SELECT * FROM templates WHERE id = ?").get(session.template_id);
  if (!template) throw new Error(`Template not found: ${session.template_id}`);

  const goals = db
    .prepare("SELECT * FROM template_goals WHERE template_id = ? ORDER BY ord")
    .all(template.id);

  const note = db
    .prepare("SELECT id, title, transcript, content FROM notes WHERE id = ?")
    .get(session.note_id);
  if (!note) throw new Error(`Note not found: ${session.note_id}`);

  const transcript = (note.transcript || "").trim() || (note.content || "").trim();
  if (!transcript) {
    throw new Error("Note has no transcript or content to synthesize");
  }

  return { session, template, goals, note, transcript };
}

// ---------------------------------------------------------------------------
// Prompt

function buildSynthesisPrompt({ template, goals, note, transcript }) {
  const outputFormat = JSON.parse(template.output_format);
  const definitionOfDone = JSON.parse(template.definition_of_done);

  const system = [
    "You are the post-meeting synthesis engine inside a consultant's meeting companion.",
    "You read one meeting transcript and produce structured outputs a human will review before anything ships. Nothing you produce is sent anywhere without explicit approval, so be honest rather than flattering.",
    "",
    "Hard rules:",
    "1. Evidence must be a VERBATIM quote from the transcript. If you cannot quote it, the goal is at best 'partial'. Never paraphrase into evidence.",
    "2. Never invent facts, names, numbers, dates, or commitments that are not in the transcript. Reflect the client's own words back to them.",
    "3. The recap tells the truth. Coverage can be green while momentum leaked — say so.",
    "4. Anchor phrases are emotionally loaded verbatim client quotes. Paraphrase does not count.",
    "5. The email draft is warm, plain, and short. First person. No hype words, no corporate filler. It reflects what the client said, commits only to what was actually agreed, and reads like a person wrote it.",
    "6. Respond with ONE JSON object and nothing else. No markdown fences, no commentary.",
  ].join("\n");

  const responseShape = {
    momentum_read: "one of: built | leaked | mixed — the honest line",
    goal_scores: [
      {
        goal_id: "id from the goals list below",
        status: "covered | partial | missed",
        evidence: "verbatim transcript quote when covered; null when missed",
      },
    ],
    recap: {
      part1: "object with one entry per part1 section listed in output_format — what we learned",
      part2: "object with one entry per part2 section listed in output_format — what happens next",
    },
    capture_candidates: [
      {
        type: "decision | pattern | anchor_phrase | open_thread",
        content: "one capturable thing, stated as the client's reality, not our artifact",
      },
    ],
    crm_move_proposal:
      "object with { next_step, next_step_date_hint, touch_summary } or null if the meeting moved nothing",
    email_draft: "object with { subject, body } or null if no follow-up email makes sense",
  };

  const prompt = [
    `TEMPLATE: ${template.name} (v${template.version})`,
    "",
    "OUTPUT FORMAT (the recap shape to fill):",
    JSON.stringify(outputFormat, null, 2),
    "",
    "DEFINITION OF DONE:",
    JSON.stringify(definitionOfDone, null, 2),
    "",
    "GOALS TO SCORE (score every one):",
    JSON.stringify(
      goals.map((g) => ({
        goal_id: g.id,
        label: g.label,
        kind: g.kind,
        satisfied_when: g.satisfied_when,
      })),
      null,
      2
    ),
    "",
    "RESPONSE SHAPE (return exactly this JSON structure):",
    JSON.stringify(responseShape, null, 2),
    "",
    `MEETING: ${note.title || "Untitled"}`,
    "TRANSCRIPT:",
    transcript,
  ].join("\n");

  return { system, prompt };
}

// ---------------------------------------------------------------------------
// Response parsing + validation

function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function extractJson(text) {
  const trimmed = String(text).trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Synthesis response contained no JSON object");
  }
  return trimmed.slice(start, end + 1);
}

// Validates the model's JSON against the goal set and the transcript.
// Honesty guards, enforced in code not vibes:
//  - unknown goal ids are dropped with a warning (never guessed at)
//  - 'covered' without evidence, or with evidence that is not actually in the
//    transcript, is downgraded to 'partial' with a warning — no unexplained
//    checkmarks ever reach goal_events (the schema CHECK backs this up).
function parseSynthesisResponse(text, goals, transcript) {
  let raw;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (err) {
    throw new Error(`Synthesis response was not valid JSON: ${err.message}`);
  }

  const warnings = [];
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const normalizedTranscript = normalizeForMatch(transcript);

  const goalScores = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.goal_scores) ? raw.goal_scores : []) {
    if (!entry || !goalById.has(entry.goal_id)) {
      warnings.push(`Dropped score for unknown goal id: ${entry && entry.goal_id}`);
      continue;
    }
    if (seen.has(entry.goal_id)) {
      warnings.push(`Dropped duplicate score for goal: ${entry.goal_id}`);
      continue;
    }
    seen.add(entry.goal_id);

    let status = GOAL_STATUSES.has(entry.status) ? entry.status : null;
    if (!status) {
      warnings.push(
        `Invalid status '${entry.status}' for goal ${entry.goal_id} — treated as missed`
      );
      status = "missed";
    }

    let evidence =
      typeof entry.evidence === "string" && entry.evidence.trim() ? entry.evidence.trim() : null;

    if (status === "covered") {
      if (!evidence) {
        warnings.push(
          `Goal '${goalById.get(entry.goal_id).label}' claimed covered without evidence — downgraded to partial`
        );
        status = "partial";
      } else if (!normalizedTranscript.includes(normalizeForMatch(evidence))) {
        warnings.push(
          `Goal '${goalById.get(entry.goal_id).label}' evidence is not verbatim in the transcript — downgraded to partial`
        );
        status = "partial";
      }
    }

    goalScores.push({ goalId: entry.goal_id, status, evidence });
  }

  for (const goal of goals) {
    if (!seen.has(goal.id)) {
      warnings.push(`Goal '${goal.label}' was not scored — recorded as missed`);
      goalScores.push({ goalId: goal.id, status: "missed", evidence: null });
    }
  }

  let momentum = MOMENTUM_READS.has(raw.momentum_read) ? raw.momentum_read : null;
  if (!momentum) warnings.push(`Missing or invalid momentum_read '${raw.momentum_read}'`);

  const captureCandidates = (Array.isArray(raw.capture_candidates) ? raw.capture_candidates : [])
    .filter((c) => c && typeof c.content === "string" && c.content.trim())
    .map((c) => ({ type: c.type || "open_thread", content: c.content.trim() }));

  const emailDraft =
    raw.email_draft && typeof raw.email_draft.body === "string" && raw.email_draft.body.trim()
      ? { subject: raw.email_draft.subject || "", body: raw.email_draft.body.trim() }
      : null;

  const crmMoveProposal =
    raw.crm_move_proposal && typeof raw.crm_move_proposal === "object"
      ? raw.crm_move_proposal
      : null;

  return {
    momentum,
    goalScores,
    recap: raw.recap || null,
    captureCandidates,
    crmMoveProposal,
    emailDraft,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// HUD score — computed locally from the scored goals, no model call.

function computeHudScore(goalScores, goals, definitionOfDone) {
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const byOrd = new Map();
  const details = [];

  let covered = 0;
  let partial = 0;
  let missed = 0;
  for (const score of goalScores) {
    const goal = goalById.get(score.goalId);
    if (!goal) continue;
    if (score.status === "covered") covered += 1;
    else if (score.status === "partial") partial += 1;
    else missed += 1;
    byOrd.set(goal.ord, score.status);
    details.push({ ord: goal.ord, label: goal.label, kind: goal.kind, status: score.status });
  }

  const requiredOrds = Array.isArray(definitionOfDone.required_goals)
    ? definitionOfDone.required_goals
    : [];
  const requiredMet = requiredOrds.every((ord) => byOrd.get(ord) === "covered");

  return {
    covered,
    partial,
    missed,
    total: goalScores.length,
    required_met: requiredMet,
    details: details.sort((a, b) => a.ord - b.ord),
  };
}

// ---------------------------------------------------------------------------
// Writing results — one transaction, everything a candidate.

function sqliteTimestamp(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function applySynthesisResult(db, { session, template, goals, parsed, ttlDays, nowMs }) {
  const deploySpec = JSON.parse(template.deploy_spec);
  const definitionOfDone = JSON.parse(template.definition_of_done);
  const ttlAt = sqliteTimestamp(
    (nowMs != null ? nowMs : Date.now()) + (ttlDays || DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000
  );

  const outputs = [];
  const goalEventIds = [];

  const run = db.transaction(() => {
    for (const score of parsed.goalScores) {
      goalEventIds.push(
        recordGoalEvent(db, {
          sessionId: session.id,
          goalId: score.goalId,
          status: score.status,
          evidence: score.evidence,
          scoredBy: "claude",
        })
      );
    }

    for (const spec of deploySpec) {
      const destination = spec.destination || null;
      if (spec.kind === "recap" && parsed.recap) {
        outputs.push({
          kind: "recap",
          id: createLoopOutput(db, {
            sessionId: session.id,
            kind: "recap",
            content: {
              recap: parsed.recap,
              momentum_read: parsed.momentum,
              template: `${template.name} v${template.version}`,
            },
            destination,
            ttlAt,
          }),
        });
      } else if (spec.kind === "hud_score") {
        outputs.push({
          kind: "hud_score",
          id: createLoopOutput(db, {
            sessionId: session.id,
            kind: "hud_score",
            content: computeHudScore(parsed.goalScores, goals, definitionOfDone),
            destination,
            ttlAt,
          }),
        });
      } else if (spec.kind === "capture_candidate") {
        for (const candidate of parsed.captureCandidates) {
          outputs.push({
            kind: "capture_candidate",
            id: createLoopOutput(db, {
              sessionId: session.id,
              kind: "capture_candidate",
              content: candidate,
              destination,
              ttlAt,
            }),
          });
        }
      } else if (spec.kind === "crm_move_proposal" && parsed.crmMoveProposal) {
        outputs.push({
          kind: "crm_move_proposal",
          id: createLoopOutput(db, {
            sessionId: session.id,
            kind: "crm_move_proposal",
            content: parsed.crmMoveProposal,
            destination,
            ttlAt,
          }),
        });
      } else if (spec.kind === "email_draft" && parsed.emailDraft) {
        outputs.push({
          kind: "email_draft",
          id: createLoopOutput(db, {
            sessionId: session.id,
            kind: "email_draft",
            content: parsed.emailDraft,
            destination,
            ttlAt,
          }),
        });
      }
    }

    if (parsed.momentum) {
      db.prepare("UPDATE sessions SET momentum_read = ? WHERE id = ?").run(
        parsed.momentum,
        session.id
      );
    }
  });
  run();

  return { outputs, goalEventIds, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Orchestrator

async function runSynthesis(db, { sessionId, generate, ttlDays, nowMs }) {
  if (typeof generate !== "function") {
    throw new Error("runSynthesis requires a generate({ system, prompt }) function");
  }
  const ctx = loadSynthesisContext(db, sessionId);
  const { system, prompt } = buildSynthesisPrompt(ctx);
  const text = await generate({ system, prompt });
  const parsed = parseSynthesisResponse(text, ctx.goals, ctx.transcript);
  const applied = applySynthesisResult(db, {
    session: ctx.session,
    template: ctx.template,
    goals: ctx.goals,
    parsed,
    ttlDays,
    nowMs,
  });
  return {
    sessionId: ctx.session.id,
    noteId: ctx.note.id,
    template: `${ctx.template.name} v${ctx.template.version}`,
    momentum: parsed.momentum,
    outputs: applied.outputs,
    goalEventCount: applied.goalEventIds.length,
    warnings: applied.warnings,
  };
}

// ---------------------------------------------------------------------------
// Production generate — BYO-key Claude via the AI SDK already in the app.

function createClaudeGenerate({
  apiKey,
  model = DEFAULT_MODEL,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    throw new Error("Anthropic API key not set — add it in Settings before running synthesis");
  }
  return async ({ system, prompt }) => {
    const { generateText } = require("ai");
    const { createAnthropic } = require("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey });
    const { text } = await generateText({
      model: anthropic(model),
      system,
      prompt,
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return text;
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TTL_DAYS,
  loadSynthesisContext,
  buildSynthesisPrompt,
  parseSynthesisResponse,
  computeHudScore,
  applySynthesisResult,
  runSynthesis,
  createClaudeGenerate,
};
