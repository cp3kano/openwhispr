import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Loader2, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import type { LoopSession, LoopTemplateSummary } from "../../types/electron";

interface NoteTemplateAttachProps {
  noteId: number;
}

// The promotion path in the metadata row: a Quick Note (no loop session, or a
// bare one) grows a template after the fact. Read-only once attached — the
// loop store pins the template version at attach time, and nothing here ever
// runs synthesis (that is increment 3). Sits beside the folder chip and
// borrows its pill styling.
export default function NoteTemplateAttach({ noteId }: NoteTemplateAttachProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<LoopSession | null>(null);
  const [templates, setTemplates] = useState<LoopTemplateSummary[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesisResult, setSynthesisResult] = useState<
    { staged: number } | { error: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setFailed(false);
    window.electronAPI
      .loopStoreGetSessionForNote(noteId)
      .then((res) => {
        if (!cancelled && res?.success) setSession(res.session ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const loadTemplates = useCallback(() => {
    window.electronAPI
      .loopStoreListTemplates()
      .then((res) => {
        if (res?.success) setTemplates(res.templates ?? []);
        setTemplatesLoaded(true);
      })
      .catch(() => setTemplatesLoaded(true));
  }, []);

  const handleAttach = useCallback(
    async (templateId: string) => {
      setAttaching(true);
      setFailed(false);
      try {
        const res = await window.electronAPI.loopStoreAttachTemplate(noteId, templateId);
        if (res?.success && res.session) {
          setSession(res.session);
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      }
      setAttaching(false);
    },
    [noteId]
  );

  // Increment 3: the synthesis trigger. One click sends the transcript through
  // the attached template; everything lands as candidates in the loop store.
  // Re-running is allowed — old candidates fade on TTL, the queue stays honest.
  const handleSynthesize = useCallback(async () => {
    setSynthesizing(true);
    setSynthesisResult(null);
    try {
      const res = await window.electronAPI.loopStoreRunSynthesis(noteId);
      if (res?.success) {
        setSynthesisResult({ staged: res.outputs?.length ?? 0 });
        window.dispatchEvent(new CustomEvent("roomtone:outputs-changed", { detail: { noteId } }));
      } else {
        setSynthesisResult({ error: res?.error || t("notes.template.synthesisError") });
      }
    } catch {
      setSynthesisResult({ error: t("notes.template.synthesisError") });
    }
    setSynthesizing(false);
  }, [noteId, t]);

  // Attached: show the template name as a quiet metadata chip, same register
  // as the date and linked-event chips, plus the synthesize action.
  if (session?.template_id) {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] text-foreground/50 dark:text-foreground/35"
          title={t("notes.template.attached")}
        >
          <LayoutTemplate size={11} className="shrink-0" />
          <span className="truncate max-w-40">
            {session.template_name || t("notes.template.attached")}
          </span>
        </span>
        <button
          onClick={handleSynthesize}
          disabled={synthesizing}
          title={t("notes.template.synthesize")}
          className="inline-flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded-md border border-border/70 dark:border-white/25 text-foreground/50 dark:text-foreground/35 hover:text-foreground/60 hover:border-border/60 hover:bg-foreground/3 dark:hover:text-foreground/40 dark:hover:border-white/10 dark:hover:bg-white/3 transition-all duration-150 cursor-pointer outline-none disabled:opacity-60 disabled:cursor-default"
        >
          {synthesizing ? (
            <Loader2 size={11} className="animate-spin shrink-0" />
          ) : (
            <Sparkles size={11} className="shrink-0" />
          )}
          {synthesizing
            ? t("notes.template.synthesizing")
            : synthesisResult && "staged" in synthesisResult
              ? t("notes.template.synthesized", { count: synthesisResult.staged })
              : t("notes.template.synthesize")}
        </button>
        {synthesisResult && "error" in synthesisResult && (
          <span
            className="text-[11px] text-red-500/80 truncate max-w-56"
            title={synthesisResult.error}
          >
            {synthesisResult.error}
          </span>
        )}
      </span>
    );
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) loadTemplates();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button className="inline-flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded-md border border-border/70 dark:border-white/25 text-foreground/50 dark:text-foreground/35 hover:text-foreground/60 hover:border-border/60 hover:bg-foreground/3 dark:hover:text-foreground/40 dark:hover:border-white/10 dark:hover:bg-white/3 transition-all duration-150 cursor-pointer outline-none">
          {attaching ? (
            <Loader2 size={11} className="animate-spin shrink-0" />
          ) : (
            <LayoutTemplate size={11} className="shrink-0" />
          )}
          {failed ? t("notes.template.error") : t("notes.template.attach")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-44 p-1">
        <div className="overflow-y-auto max-h-48">
          {templatesLoaded && templates.length === 0 && (
            <p className="text-xs text-foreground/20 text-center py-1.5">
              {t("notes.template.empty")}
            </p>
          )}
          {templates.map((tpl) => (
            <DropdownMenuItem
              key={tpl.id}
              disabled={attaching}
              onClick={() => handleAttach(tpl.id)}
              className="text-xs gap-2 rounded-md px-2 py-1.5"
            >
              <LayoutTemplate size={11} className="text-foreground/30 shrink-0" />
              <span className="truncate flex-1">{tpl.name}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
