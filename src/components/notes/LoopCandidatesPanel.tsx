import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Copy, Loader2, X } from "lucide-react";
import type { LoopOutput } from "../../types/electron";

interface LoopCandidatesPanelProps {
  noteId: number;
}

// Increment 4: the nod queue gets a face. Every synthesis candidate for this
// note's session shows up as a card — recap, coverage, captures, CRM move,
// email draft — with one-click approve and an explicit dismiss (fade).
// Approve here only flips status in the loop store; committing to external
// destinations is a later increment. Copy puts the artifact on the clipboard
// so approved drafts are immediately usable by a human.

type ParsedOutput = LoopOutput & { parsed: unknown };

const KIND_ORDER: Record<string, number> = {
  recap: 0,
  hud_score: 1,
  capture_candidate: 2,
  crm_move_proposal: 3,
  email_draft: 4,
  insight: 5,
};

function parseContent(output: LoopOutput): ParsedOutput {
  let parsed: unknown = output.content;
  try {
    parsed = JSON.parse(output.content);
  } catch {
    // plain-text content is fine as-is
  }
  return { ...output, parsed };
}

function prettifySectionName(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function asClipboardText(output: ParsedOutput): string {
  const p = output.parsed as Record<string, unknown> | string | null;
  if (typeof p === "string") return p;
  if (!p || typeof p !== "object") return output.content;
  if (output.kind === "email_draft") {
    const subject = (p as { subject?: string }).subject;
    const body = (p as { body?: string }).body;
    return [subject ? `Subject: ${subject}` : null, body].filter(Boolean).join("\n\n");
  }
  if (output.kind === "capture_candidate") {
    return String((p as { content?: string }).content ?? output.content);
  }
  if (output.kind === "recap") {
    const recap = (p as { recap?: Record<string, Record<string, unknown>> }).recap;
    if (!recap) return output.content;
    const lines: string[] = [];
    for (const part of ["part1", "part2"]) {
      const sections = recap[part];
      if (!sections || typeof sections !== "object") continue;
      for (const [key, value] of Object.entries(sections)) {
        lines.push(
          `${prettifySectionName(key)}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`
        );
      }
    }
    return lines.join("\n\n");
  }
  return JSON.stringify(p, null, 2);
}

function RecapBody({ parsed }: { parsed: Record<string, unknown> }) {
  const recap = parsed.recap as Record<string, Record<string, unknown>> | undefined;
  const momentum = parsed.momentum_read as string | undefined;
  if (!recap) return null;
  return (
    <div className="space-y-2">
      {momentum && (
        <span className="inline-block text-[10px] uppercase tracking-wide text-foreground/40">
          {momentum}
        </span>
      )}
      {["part1", "part2"].map((part) => {
        const sections = recap[part];
        if (!sections || typeof sections !== "object") return null;
        return (
          <div key={part} className="space-y-1.5">
            {Object.entries(sections).map(([key, value]) => (
              <div key={key}>
                <p className="text-[10px] uppercase tracking-wide text-foreground/35">
                  {prettifySectionName(key)}
                </p>
                <p className="text-xs text-foreground/70 whitespace-pre-wrap">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </p>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function HudBody({ parsed }: { parsed: Record<string, unknown> }) {
  const { t } = useTranslation();
  const details = (parsed.details as Array<{ ord: number; label: string; status: string }>) ?? [];
  const requiredMet = Boolean(parsed.required_met);
  const dot = (status: string) =>
    status === "covered"
      ? "bg-emerald-500/70"
      : status === "partial"
        ? "bg-amber-400/70"
        : "bg-foreground/20";
  return (
    <div className="space-y-1.5">
      <p className={`text-[11px] ${requiredMet ? "text-emerald-600/80" : "text-amber-600/80"}`}>
        {requiredMet ? t("notes.candidates.requiredMet") : t("notes.candidates.requiredNotMet")}
      </p>
      <div className="space-y-1">
        {details.map((d) => (
          <div key={d.ord} className="flex items-center gap-2 text-xs text-foreground/60">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(d.status)}`} />
            <span className="truncate">{d.label}</span>
            <span className="text-foreground/30 text-[10px]">{d.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GenericBody({ output }: { output: ParsedOutput }) {
  const p = output.parsed as Record<string, unknown> | string;
  if (typeof p === "string") {
    return <p className="text-xs text-foreground/70 whitespace-pre-wrap">{p}</p>;
  }
  if (output.kind === "email_draft") {
    const subject = (p as { subject?: string }).subject;
    const body = (p as { body?: string }).body;
    return (
      <div className="space-y-1">
        {subject && <p className="text-xs font-medium text-foreground/75">{subject}</p>}
        <p className="text-xs text-foreground/70 whitespace-pre-wrap">{body}</p>
      </div>
    );
  }
  if (output.kind === "capture_candidate") {
    const type = (p as { type?: string }).type;
    const content = (p as { content?: string }).content;
    return (
      <div className="space-y-1">
        {type && (
          <span className="inline-block text-[10px] uppercase tracking-wide text-foreground/35">
            {type.replace(/_/g, " ")}
          </span>
        )}
        <p className="text-xs text-foreground/70 whitespace-pre-wrap">{content}</p>
      </div>
    );
  }
  if (output.kind === "crm_move_proposal") {
    const entries = Object.entries(p as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string" && v
    );
    return (
      <div className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key}>
            <p className="text-[10px] uppercase tracking-wide text-foreground/35">
              {prettifySectionName(key)}
            </p>
            <p className="text-xs text-foreground/70">{String(value)}</p>
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="text-xs text-foreground/60 whitespace-pre-wrap font-mono">
      {JSON.stringify(p, null, 2)}
    </p>
  );
}

export default function LoopCandidatesPanel({ noteId }: LoopCandidatesPanelProps) {
  const { t } = useTranslation();
  const [outputs, setOutputs] = useState<ParsedOutput[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(() => {
    window.electronAPI
      .loopStoreGetSessionForNote(noteId)
      .then((res) => {
        if (!res?.success || !res.session) {
          setOutputs([]);
          return;
        }
        return window.electronAPI.loopStoreListOutputs(res.session.id).then((out) => {
          if (out?.success) {
            const visible = (out.outputs ?? [])
              .filter((o) => o.status === "candidate" || o.status === "approved")
              .map(parseContent)
              .sort(
                (a, b) =>
                  (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
                  a.created_at.localeCompare(b.created_at)
              );
            setOutputs(visible);
          }
        });
      })
      .catch(() => {});
  }, [noteId]);

  useEffect(() => {
    load();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ noteId?: number }>).detail;
      if (!detail || detail.noteId === noteId) load();
    };
    window.addEventListener("roomtone:outputs-changed", onChange);
    return () => window.removeEventListener("roomtone:outputs-changed", onChange);
  }, [noteId, load]);

  const handleApprove = useCallback(async (outputId: string) => {
    setBusyId(outputId);
    try {
      const res = await window.electronAPI.loopStoreApproveOutput(outputId);
      if (res?.success && res.output) {
        setOutputs((prev) =>
          prev.map((o) => (o.id === outputId ? { ...o, status: "approved" } : o))
        );
      }
    } catch {
      // leave the card as-is; the store is the truth
    }
    setBusyId(null);
  }, []);

  const handleFade = useCallback(async (outputId: string) => {
    setBusyId(outputId);
    try {
      const res = await window.electronAPI.loopStoreFadeOutput(outputId);
      if (res?.success) {
        setOutputs((prev) => prev.filter((o) => o.id !== outputId));
      }
    } catch {
      // leave the card as-is
    }
    setBusyId(null);
  }, []);

  const handleCopy = useCallback(async (output: ParsedOutput) => {
    try {
      await navigator.clipboard.writeText(asClipboardText(output));
      setCopiedId(output.id);
      setTimeout(() => setCopiedId((prev) => (prev === output.id ? null : prev)), 1500);
    } catch {
      // clipboard denied — nothing to do
    }
  }, []);

  if (outputs.length === 0) return null;

  const pendingCount = outputs.filter((o) => o.status === "candidate").length;

  return (
    <div className="border-b border-border/40 dark:border-white/8 px-4 py-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-foreground/50 dark:text-foreground/35 hover:text-foreground/70 transition-colors duration-150 cursor-pointer outline-none"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {t("notes.candidates.title")}
        <span className="text-foreground/30 tabular-nums">
          {pendingCount > 0 ? `${pendingCount}` : "✓"}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {outputs.map((output) => (
            <div
              key={output.id}
              className={`rounded-lg border p-2.5 space-y-1.5 transition-opacity ${
                output.status === "approved"
                  ? "border-emerald-500/30 bg-emerald-500/4"
                  : "border-border/60 dark:border-white/10"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-foreground/40 flex-1">
                  {t(`notes.candidates.kinds.${output.kind}`)}
                </span>
                {output.status === "approved" ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600/80">
                    <Check size={10} />
                    {t("notes.candidates.approved")}
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => handleApprove(output.id)}
                      disabled={busyId === output.id}
                      title={t("notes.candidates.approve")}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border border-emerald-500/40 text-emerald-600/90 hover:bg-emerald-500/10 transition-colors duration-150 cursor-pointer outline-none disabled:opacity-50"
                    >
                      {busyId === output.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Check size={10} />
                      )}
                      {t("notes.candidates.approve")}
                    </button>
                    <button
                      onClick={() => handleFade(output.id)}
                      disabled={busyId === output.id}
                      title={t("notes.candidates.dismiss")}
                      className="inline-flex items-center justify-center h-5 w-5 rounded-md text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 transition-colors duration-150 cursor-pointer outline-none disabled:opacity-50"
                    >
                      <X size={10} />
                    </button>
                  </>
                )}
                <button
                  onClick={() => handleCopy(output)}
                  title={t("notes.candidates.copy")}
                  className="inline-flex items-center justify-center h-5 w-5 rounded-md text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 transition-colors duration-150 cursor-pointer outline-none"
                >
                  {copiedId === output.id ? (
                    <Check size={10} className="text-emerald-500" />
                  ) : (
                    <Copy size={10} />
                  )}
                </button>
              </div>
              {output.kind === "recap" ? (
                <RecapBody parsed={output.parsed as Record<string, unknown>} />
              ) : output.kind === "hud_score" ? (
                <HudBody parsed={output.parsed as Record<string, unknown>} />
              ) : (
                <GenericBody output={output} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
