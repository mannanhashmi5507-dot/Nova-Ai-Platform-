const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateStreak, daysBetween, toDateOnly } = require('../src/productivity/streaks');

test('daysBetween computes simple consecutive days correctly', () => {
  assert.equal(daysBetween('2026-07-01', '2026-07-02'), 1);
  assert.equal(daysBetween('2026-07-01', '2026-07-01'), 0);
});

test('daysBetween handles a month boundary correctly', () => {
  assert.equal(daysBetween('2026-07-31', '2026-08-01'), 1);
});

test('daysBetween handles a leap year February correctly', () => {
  // 2028 is a leap year
  assert.equal(daysBetween('2028-02-28', '2028-02-29'), 1);
  assert.equal(daysBetween('2028-02-29', '2028-03-01'), 1);
});

test('toDateOnly rejects an invalid date rather than silently producing "Invalid Date"', () => {
  assert.throws(() => toDateOnly('not a date'), /Invalid date/);
});

test('empty completion history returns all zeros, not an error', () => {
  const result = calculateStreak([], '2026-07-30');
  assert.deepEqual(result, { currentStreak: 0, longestStreak: 0, totalCompletions: 0, lastCompletedDate: null });
});

test('a single completion today gives a current streak of 1', () => {
  const result = calculateStreak(['2026-07-30'], '2026-07-30');
  assert.equal(result.currentStreak, 1);
  assert.equal(result.longestStreak, 1);
});

test('completions on 5 consecutive days give a current streak of 5', () => {
  const dates = ['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'];
  const result = calculateStreak(dates, '2026-07-30');
  assert.equal(result.currentStreak, 5);
  assert.equal(result.longestStreak, 5);
});

test('a completion yesterday (not today) still counts as an active current streak', () => {
  // Habit-tracker convention: "current streak" shouldn't reset to 0 just
  // because today hasn't happened yet — only when a full day is skipped.
  const result = calculateStreak(['2026-07-29'], '2026-07-30');
  assert.equal(result.currentStreak, 1);
});

test('THE KEY EDGE CASE: a gap of 2+ days breaks the current streak to 0, even with a long history', () => {
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22']; // last completion 8 days before "today"
  const result = calculateStreak(dates, '2026-07-30');
  assert.equal(result.currentStreak, 0, 'streak must reset after a real gap, not stay stuck at the old value');
  assert.equal(result.longestStreak, 3, 'longest streak is still correctly remembered from history');
});

test('a gap in the MIDDLE of history correctly breaks the run there but not the current streak calc', () => {
  const dates = ['2026-07-10', '2026-07-11', '2026-07-25', '2026-07-26', '2026-07-27'];
  const result = calculateStreak(dates, '2026-07-27');
  assert.equal(result.currentStreak, 3, 'current streak only counts the unbroken run ending at the most recent completion');
  assert.equal(result.longestStreak, 3, 'longest streak in this case ties between both 2-day and 3-day runs, so equals 3');
});

test('longestStreak correctly finds a long run buried earlier in history, even if current streak is short', () => {
  const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-29'];
  const result = calculateStreak(dates, '2026-07-30');
  assert.equal(result.longestStreak, 5, 'the 5-day run earlier in history must still be found as the longest');
  // The last completion (7-29) is "yesterday" relative to 7-30, which per
  // the deliberate rule tested above still counts as an active streak —
  // just a short one (1), not broken (0). A broken streak requires a
  // gap of 2+ days, which this isn't.
  assert.equal(result.currentStreak, 1, 'current streak is short (isolated day) but still active, not broken');
});

test('duplicate completion entries for the same day do not inflate the streak', () => {
  const dates = ['2026-07-29', '2026-07-29', '2026-07-30', '2026-07-30'];
  const result = calculateStreak(dates, '2026-07-30');
  assert.equal(result.totalCompletions, 2, 'duplicates on the same day must be deduplicated');
  assert.equal(result.currentStreak, 2);
});

test('completion dates given out of order are handled correctly (sorted internally)', () => {
  const dates = ['2026-07-28', '2026-07-26', '2026-07-27'];
  const result = calculateStreak(dates, '2026-07-28');
  assert.equal(result.currentStreak, 3);
});

test('a completion recorded for "today" that is actually in the future relative to asOfDate is still handled without crashing', () => {
  // Defensive: shouldn't throw even on unusual input ordering.
  assert.doesNotThrow(() => calculateStreak(['2026-08-05'], '2026-07-30'));
});

test('accepts Date objects as well as date strings', () => {
  const result = calculateStreak([new Date('2026-07-30T15:00:00Z')], new Date('2026-07-30T08:00:00Z'));
  assert.equal(result.currentStreak, 1);
});

test('lastCompletedDate reflects the true most recent day, not just the last array entry', () => {
  const result = calculateStreak(['2026-07-15', '2026-07-30', '2026-07-20'], '2026-07-30');
  assert.equal(result.lastCompletedDate, '2026-07-30');
});
