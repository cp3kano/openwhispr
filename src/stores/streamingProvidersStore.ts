import { create } from "zustand";

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

interface StreamingProvidersState {
  providers: NoteRecordingProvider[] | null;
}

export const useStreamingProvidersStore = create<StreamingProvidersState>()(() => ({
  providers: null,
}));

// The provider catalog used to be served by the hosted API. With the hosted
// tier gone there is no catalog to fetch; consumers fall back to their
// built-in defaults when the store holds null.
