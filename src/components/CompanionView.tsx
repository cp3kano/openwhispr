import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDot, LayoutTemplate, MessageCircleQuestion, Sunrise } from "lucide-react";
import type { CompanionCandidate, CompanionSummary } from "../types/electron";

// Increment 8: the daily companion, v0. A read-only morning view over the
// loop store: what's waiting for a nod, which threads are still open, and
// how the recent sessions went. Nothing here mutates anything — approval
// still happens on the note, where the context lives.

function candidatePreview(candidate: CompanionCandidate): string {
  try {
    const parsed = JSON.parse(candidate.content);
    if (typeof parsed === "string") return parsed;
    if (parsed?.content) return String(parsed.content);
    if (parsed?.subject) return String(parsed.subject);
    if (parsed?.next_step) return String(parsed.next_step);
    if (parsed?.recap) return "Recap ready for review";
    if (parsed?.covered != null) return "Coverage scoreboard";
    return candidate.content.slice(0, 120);
  } catch {
    return candidate.content.slice(0, 120);
  }
}

function momentumTone(momentum: string | null): string {
  if (momentum === "built") return "text-emerald-600/80";
  if (momentum === "leaked") return "text-red-500/80";
  if (momentum === "mixed") return "text-amber-500/80";
  return "text-foreground/30";
}

export default function CompanionView() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<CompanionSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    window.electronAPI
      .loopStoreCompanionSummary()
      .then((res) => {
        if (res?.success && res.summary) setSummary(res.summary);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return <div className="p-6 text-sm text-foreground/40">{t("companion.error")}</div>;
  }
  if (!summary) {
    return <div className="p-6 text-sm text-foreground/30">{t("companion.loading")}</div>;
  }

  const byNote = new Map<string, CompanionCandidate[]>();
  for (const candidate of summary.pending) {
    const key = candidate.note_title || t("companion.untitled");
    if (!byNote.has(key)) byNote.set(key, []);
    byNote.get(key)!.push(candidate);
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-3xl">
      <div className="flex items-center gap-2">
        <Sunrise size={16} className="text-foreground/40" />
        <h1 className="text-sm font-medium text-foreground/70">{t("companion.title")}</h1>
        <span className="text-xs text-foreground/30 tabular-nums">
          {t("companion.counts", {
            pending: summary.counts.pending,
            approved: summary.counts.approved_today,
          })}
        </span>
      </div>

      <section className="space-y-2">
        <h2 className="text-[11px] uppercase tracking-wide text-foreground/35">
          {t("companion.nodQueue")}
        </h2>
        {byNote.size === 0 && (
          <p className="text-xs text-foreground/30">{t("companion.queueEmpty")}</p>
        )}
        {[...byNote.entries()].map(([noteTitle, candidates]) => (
          <div
            key={noteTitle}
            className="rounded-lg border border-border/60 dark:border-white/10 p-3 space-y-1.5"
          >
            <p className="text-xs font-medium text-foreground/70 truncate">{noteTitle}</p>
            {candidates.map((candidate) => (
              <div key={candidate.id} className="flex items-baseline gap-2 text-xs">
                <span className="text-[10px] uppercase tracking-wide text-foreground/35 shrink-0 w-20">
                  {t(`notes.candidates.kinds.${candidate.kind}`)}
                </span>
                <span className="text-foreground/55 truncate">{candidatePreview(candidate)}</span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] uppercase tracking-wide text-foreground/35">
          {t("companion.openThreads")}
        </h2>
        {summary.open_threads.length === 0 && (
          <p className="text-xs text-foreground/30">{t("companion.threadsEmpty")}</p>
        )}
        {summary.open_threads.map((thread) => (
          <div key={thread.id} className="flex items-start gap-2 text-xs">
            <MessageCircleQuestion size={12} className="text-foreground/30 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-foreground/60">{candidatePreview(thread)}</p>
              <p className="text-[10px] text-foreground/30 truncate">{thread.note_title}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] uppercase tracking-wide text-foreground/35">
          {t("companion.recentSessions")}
        </h2>
        {summary.sessions.length === 0 && (
          <p className="text-xs text-foreground/30">{t("companion.sessionsEmpty")}</p>
        )}
        {summary.sessions.map((session) => (
          <div key={session.id} className="flex items-center gap-2 text-xs">
            <CircleDot size={10} className={`shrink-0 ${momentumTone(session.momentum_read)}`} />
            <span className="text-foreground/60 truncate flex-1">
              {session.note_title || t("companion.untitled")}
            </span>
            {session.template_name && (
              <span className="inline-flex items-center gap-1 text-[10px] text-foreground/30 shrink-0">
                <LayoutTemplate size={9} />
                {session.template_name}
              </span>
            )}
            {session.momentum_read && (
              <span className={`text-[10px] shrink-0 ${momentumTone(session.momentum_read)}`}>
                {session.momentum_read}
              </span>
            )}
            {session.pending_candidates > 0 && (
              <span className="text-[10px] text-foreground/30 tabular-nums shrink-0">
                {session.pending_candidates}
              </span>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
