// Re-export the core ops namespace members used by the formatters.
import { ops } from '@automedo/core';
export const { checkpointDue, currentPhase, dueAt, nextCheckpointAt, orderedTasks } = ops;
export { diffSummary, fmtAgo, type Goal } from '@automedo/core';
