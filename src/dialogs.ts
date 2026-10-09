export type Dialog =
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
  | { type: 'switch' }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void };
