export type Mode = 'plan' | 'goal';
export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked' | 'skipped';
export type PhaseStatus = 'pending' | 'active' | 'done';
export type WsStatus = 'active' | 'paused' | 'done' | 'archived';
export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Effort = 'low' | 'medium' | 'high';
export type Verdict = 'on-track' | 'drifting' | 'blocked' | 'pivot';

export type EventType =
  | 'create'
  | 'add' // task added
  | 'remove' // task or phase removed
  | 'edit' // title/goal/objective edited without a recorded reason
  | 'phase-add'
  | 'phase' // phase completed / activated
  | 'start'
  | 'done'
  | 'block'
  | 'unblock'
  | 'pause'
  | 'skip'
  | 'reopen'
  | 'defer'
  | 'revise' // reasoned change → new plan version
  | 'commit' // plan version snapshot (auto v1 or manual /commit)
  | 'note'
  | 'session-start'
  | 'session-end'
  | 'checkpoint'
  | 'compact'
  | 'legacy'; // free-text entries migrated from older versions

export interface DiffLine {
  sign: '+' | '-' | '~' | ' ' | '!';
  num?: number;
  text: string;
  note?: string;
}

/** One entry of the Execution Log. `text` is always a readable one-line summary. */
export interface LogEntry {
  id: string;
  at: number;
  type: EventType;
  text: string;
  taskId?: string;
  title?: string; // task / phase title at the time of the event
  phaseId?: string;
  runId?: string; // focus session this happened in
  reason?: string;
  detail?: string;
  diff?: DiffLine[];
  version?: number;
  durMs?: number;
  tokens?: number;
}

/** A snapshot of the plan structure — the "commit" a Plan Diff compares against. */
export interface PlanVersion {
  /** Globally unique (sync identity); `v` is only the display number. Absent on old data. */
  id?: string;
  v: number;
  at: number;
  message: string;
  phases: { id: string; title: string; goal: string; due?: string }[];
  tasks: { id: string; title: string; phaseId: string | null }[];
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  phaseId: string | null;
  note?: string;
  createdAt: number;
  doneAt?: number;
  /** Device working on it while active (several devices can each have one in progress). */
  activeBy?: string;
}

export interface Phase {
  id: string;
  title: string;
  goal: string;
  status: PhaseStatus;
  due?: string; // optional target date, YYYY-MM-DD
  doneAt?: number;
}

interface WorkspaceBase {
  id: string;
  title: string;
  status: WsStatus;
  log: LogEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface Plan extends WorkspaceBase {
  kind: 'plan';
  objective: string;
  phases: Phase[];
  tasks: Task[];
  versions: PlanVersion[];
}

export interface Checkpoint {
  id: string;
  at: number;
  progress: number; // 0-100, self-rated
  verdict: Verdict;
  did: string;
  learned: string;
  next: string;
}

export interface Goal extends WorkspaceBase {
  kind: 'goal';
  why: string;
  doneWhen: string;
  cadenceDays: number;
  nextAction: string;
  moves: Task[]; // quick actions, phaseId always null
  checkpoints: Checkpoint[];
}

export type Workspace = Plan | Goal;

export interface Session {
  id: string;
  /** Segments created by switching tier/effort mid-session share a runId. */
  runId: string;
  wsId: string | null;
  tier: Tier;
  effort: Effort;
  intent: string;
  startedAt: number;
  plannedMin: number;
  endedAt?: number;
  tokens?: number;
  fatigue?: number; // 1-5 self-report
  outcome?: string;
  /** Device the session runs on; sessions on different devices run in parallel. */
  device?: string;
}

export interface Compact {
  id: string;
  wsId: string;
  at: number;
  text: string;
}

export interface FatigueMark {
  at: number;
  level: number;
}

export interface Settings {
  dailyBudget: number;
  /** When the user last changed a setting (decides first-contact sync conflicts). */
  updatedAt?: number;
}

export interface AppState {
  version: 1;
  plans: Plan[];
  goals: Goal[];
  sessions: Session[];
  compacts: Compact[];
  fatigue: FatigueMark[];
  settings: Settings;
  hie: { tier: Tier; effort: Effort; updatedAt?: number };
  ui: {
    mode: Mode;
    activePlanId: string | null;
    activeGoalId: string | null;
    lastSeenAt: number;
    dismissedCompactId: string | null;
    /** This device (UI state is never synced). Tags the tasks and sessions it runs. */
    deviceId?: string;
  };
}
