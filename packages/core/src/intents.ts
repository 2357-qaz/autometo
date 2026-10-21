/**
 * Something a command wants the UI to do: show a form, a list, a confirmation.
 * Each client decides how to present it (web: modal dialog, TUI: inline form).
 */
export type Intent =
  | { type: 'newPlan'; title?: string }
  | { type: 'newGoal'; title?: string }
  | { type: 'session'; minutes?: number }
  | { type: 'endSession' }
  | { type: 'revise'; phaseId: string }
  | { type: 'checkpoint'; goalId: string }
  | { type: 'compact'; wsId: string }
  | { type: 'resume'; compactId: string }
  | { type: 'editTask'; taskId: string }
  | { type: 'help' }
  /** Weekly review; offset 0 = this week, -1 = last week, … */
  | { type: 'review'; offset: number }
  | { type: 'sync' }
  | { type: 'switch' }
  /** Pick one value (model tier, effort, fatigue) — see pickSpec. */
  | { type: 'pick'; what: import('./picks').PickKind }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void };
