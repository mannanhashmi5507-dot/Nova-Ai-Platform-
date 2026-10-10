// ─── Productivity: Habit Streak Calculation ───────────────────
// Phase 12. Pure date math, no AI, no I/O — streaks need to be exactly
// right or the feature is untrustworthy. Dates are normalized to
// YYYY-MM-DD strings throughout (not Date objects with time components)
// specifically to avoid timezone/DST edge cases corrupting day-boundary
// comparisons — a classic real bug in habit-tracker/streak code.

function toDateOnly(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateInput}`);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC-normalized
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// completionDates: array of date strings/Date objects when the habit was
// completed (any order, duplicates tolerated). asOfDate: "today" for the
// purpose of calculating the CURRENT streak — defaults to real today,
// but is an explicit parameter so this is deterministically testable.
function calculateStreak(completionDates, asOfDate = new Date()) {
  const uniqueDays = [...new Set(completionDates.map(toDateOnly))].sort();
  const today = toDateOnly(asOfDate);

  if (uniqueDays.length === 0) {
    return { currentStreak: 0, longestStreak: 0, totalCompletions: 0, lastCompletedDate: null };
  }

  // Longest streak ever: scan chronologically, break the run whenever
  // consecutive days aren't exactly 1 apart.
  let longestStreak = 1;
  let runLength = 1;
  for (let i = 1; i < uniqueDays.length; i++) {
    if (daysBetween(uniqueDays[i - 1], uniqueDays[i]) === 1) {
      runLength++;
    } else {
      runLength = 1;
    }
    longestStreak = Math.max(longestStreak, runLength);
  }

  // Current streak: walk backward from the most recent completion. It
  // only counts as "current" if the most recent completion was today or
  // yesterday — a habit not done in the last 2 days has a broken streak,
  // not a stale-but-alive one.
  const lastCompletedDate = uniqueDays[uniqueDays.length - 1];
  const gapFromToday = daysBetween(lastCompletedDate, today);

  let currentStreak = 0;
  if (gapFromToday <= 1) {
    currentStreak = 1;
    for (let i = uniqueDays.length - 1; i > 0; i--) {
      if (daysBetween(uniqueDays[i - 1], uniqueDays[i]) === 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return { currentStreak, longestStreak, totalCompletions: uniqueDays.length, lastCompletedDate };
}

module.exports = { calculateStreak, toDateOnly, daysBetween };
