// ─── Productivity: Progress Calculations ─────────────────────
// Phase 12. Pure math, same pattern as finance/planners.js and
// business/invoiceMath.js — deterministic, no AI, exhaustively testable.

function calculateGoalProgress(currentValue, targetValue) {
  if (typeof currentValue !== 'number' || typeof targetValue !== 'number') {
    throw new Error('currentValue and targetValue must be numbers');
  }
  if (targetValue === 0) {
    return { percentComplete: currentValue >= 0 ? 100 : 0, isComplete: currentValue >= 0 };
  }
  const raw = (currentValue / targetValue) * 100;
  const percentComplete = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  return { percentComplete, isComplete: currentValue >= targetValue };
}

// Project progress: percent of tasks completed. Real, simple, but
// correctly handles the empty-project edge case (0 tasks) without
// producing NaN or a misleading 100%/0%.
function calculateProjectProgress(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { totalTasks: 0, completedTasks: 0, percentComplete: 0 };
  }
  const completedTasks = tasks.filter(t => t.completed).length;
  const percentComplete = Math.round((completedTasks / tasks.length) * 1000) / 10;
  return { totalTasks: tasks.length, completedTasks, percentComplete };
}

module.exports = { calculateGoalProgress, calculateProjectProgress };
