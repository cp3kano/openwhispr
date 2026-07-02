import { useState, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isProUser: boolean;
  isProLoading: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  // Hosted Pro tier removed — everyone is a full user of their own app.
  const isProUser = false;
  const isProLoading = false;
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const effectiveModel = useSettingsStore((s) => s.cleanupModel);

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = useCleanupModel && !!effectiveModel;

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isProUser, isProLoading, isLLMConfigured, complete };
}
