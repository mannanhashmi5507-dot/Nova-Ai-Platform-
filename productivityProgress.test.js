const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGoalProgress, calculateProjectProgress } = require('../src/productivity/progress');

test('goal progress: halfway to target is exactly 50%', () => {
  const result = calculateGoalProgress(50, 100);
  assert.equal(result.percentComplete, 50);
  assert.equal(result.isComplete, false);
});

test('goal progress: reaching the target is exactly 100% and marked complete', () => {
  const result = calculateGoalProgress(100, 100);
  assert.equal(result.percentComplete, 100);
  assert.equal(result.isComplete, true);
});

test('goal progress: exceeding the target caps at 100%, still marked complete', () => {
  const result = calculateGoalProgress(150, 100);
  assert.equal(result.percentComplete, 100);
  assert.equal(result.isComplete, true);
});

test('goal progress: negative current value floors at 0%, not a negative percent', () => {
  const result = calculateGoalProgress(-10, 100);
  assert.equal(result.percentComplete, 0);
});

test('goal progress: zero target with non-negative current value is treated as already complete', () => {
  const result = calculateGoalProgress(5, 0);
  assert.equal(result.percentComplete, 100);
  assert.equal(result.isComplete, true);
});

test('goal progress: zero target with negative current value is 0%, not a division-by-zero crash', () => {
  const result = calculateGoalProgress(-5, 0);
  assert.equal(result.percentComplete, 0);
  assert.equal(result.isComplete, false);
});

test('goal progress rejects non-numeric inputs', () => {
  assert.throws(() => calculateGoalProgress('50', 100), /must be numbers/);
  assert.throws(() => calculateGoalProgress(50, null), /must be numbers/);
});

test('goal progress rounds to one decimal place, not a long float', () => {
  const result = calculateGoalProgress(1, 3);
  assert.equal(result.percentComplete, 33.3);
});

test('project progress: empty task list is 0% complete, not NaN or a crash', () => {
  const result = calculateProjectProgress([]);
  assert.deepEqual(result, { totalTasks: 0, completedTasks: 0, percentComplete: 0 });
});

test('project progress: all tasks complete is exactly 100%', () => {
  const result = calculateProjectProgress([{ completed: true }, { completed: true }]);
  assert.equal(result.percentComplete, 100);
});

test('project progress: none complete is exactly 0%', () => {
  const result = calculateProjectProgress([{ completed: false }, { completed: false }]);
  assert.equal(result.percentComplete, 0);
});

test('project progress: partial completion computes the correct real percentage', () => {
  const result = calculateProjectProgress([{ completed: true }, { completed: false }, { completed: false }]);
  assert.equal(result.totalTasks, 3);
  assert.equal(result.completedTasks, 1);
  assert.ok(Math.abs(result.percentComplete - 33.3) < 0.1);
});

test('project progress rejects non-array input by treating it as empty rather than crashing', () => {
  const result = calculateProjectProgress(null);
  assert.equal(result.percentComplete, 0);
});
