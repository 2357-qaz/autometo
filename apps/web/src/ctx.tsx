import { createContext, useContext } from 'react';
import type { Intent as Dialog } from '@automedo/core';
import type { Store } from '@automedo/core';
import type { AppState } from '@automedo/core';

export interface Output {
  cmd: string;
  text: string;
  error?: boolean;
  undoable?: boolean;
  at: number;
}

export interface AppCtx {
  store: Store;
  state: AppState;
  open: (d: Dialog) => void;
  close: () => void;
  /** Run a mutation with undo + output line; returns false on user error. */
  act: (label: string, fn: (d: AppState) => string | void, cmd?: string) => boolean;
  say: (o: Omit<Output, 'at'>) => void;
  focusPrompt: (prefill?: string) => void;
  run: (input: string) => void;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppCtx missing');
  return c;
}
