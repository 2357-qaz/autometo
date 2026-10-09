export type Mode = 'plan' | 'goal';
export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked' | 'skipped';
export type PhaseStatus = 'pending' | 'active' | 'done';
export type WsStatus = 'active' | 'paused' | 'done' | 'archived';
export type Tier = 'lite' | 'core' | 'deep';
export type Effort = 'low' | 'medium' | 'high';
export type Verdict = 'on-track' | 'drifting' | 'blocked' | 'pivot';

export type LogKind =
  | 'create'
  | 'task'
  | 'phase'
  | 'revise'
  | 'note'
  | 'session'
  | 'compact'
  | 'checkpoint';

export interface LogEntry {
  id: string;
  at: number;
  kind: LogKind;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  phaseId: string | null;
  note?: string;
  createdAt: number;
  doneAt?: number;
}

export interface Phase {
  id: string;
  title: string;
  goal: string;
  status: PhaseStatus;
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
}

export interface AppState {
  version: 1;
  plans: Plan[];
  goals: Goal[];
  sessions: Session[];
  compacts: Compact[];
  fatigue: FatigueMark[];
  settings: Settings;
  hie: { tier: Tier; effort: Effort };
  ui: {
    mode: Mode;
    activePlanId: string | null;
    activeGoalId: string | null;
    lastSeenAt: number;
    dismissedCompactId: string | null;
  };
}
