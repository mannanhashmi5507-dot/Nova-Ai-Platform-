const test = require('node:test');
const assert = require('node:assert/strict');
const { spendingPlan50_30_20, investmentProjection, requiredMonthlySavings, calculateNetWorth } = require('../src/finance/planners');

test('50/30/20 rule splits income correctly', () => {
  const result = spendingPlan50_30_20(5000);
  assert.equal(result.needs, 2500);
  assert.equal(result.wants, 1500);
  assert.equal(result.savingsOrDebt, 1000);
  assert.equal(result.framework, '50/30/20 rule');
});

test('50/30/20 rejects a negative income', () => {
  assert.throws(() => spendingPlan50_30_20(-100), /non-negative/);
});

test('50/30/20 handles zero income without error', () => {
  const result = spendingPlan50_30_20(0);
  assert.equal(result.needs, 0);
});

test('investmentProjection with zero return: future value equals total contributed exactly', () => {
  const result = investmentProjection({ principal: 1000, monthlyContribution: 100, annualReturnPercent: 0, years: 2 });
  // 1000 + 100*24 = 3400, no growth
  assert.equal(result.totalContributed, 3400);
  assert.equal(result.futureValue, 3400);
  assert.equal(result.totalGrowth, 0);
});

test('investmentProjection with a lump sum only (no contributions) matches standard compound interest', () => {
  // $10,000 at 12% annual (1% monthly) for 1 year = 10000 * 1.01^12
  const result = investmentProjection({ principal: 10000, monthlyContribution: 0, annualReturnPercent: 12, years: 1 });
  const expected = Math.round(10000 * Math.pow(1.01, 12) * 100) / 100;
  assert.equal(result.futureValue, expected);
});

test('investmentProjection growth is positive when return > 0 and negative growth is impossible', () => {
  const result = investmentProjection({ principal: 5000, monthlyContribution: 200, annualReturnPercent: 7, years: 10 });
  assert.ok(result.totalGrowth > 0);
  assert.ok(result.futureValue > result.totalContributed);
});

test('investmentProjection rejects negative inputs', () => {
  assert.throws(() => investmentProjection({ principal: -1, annualReturnPercent: 5, years: 1 }), /non-negative/);
  assert.throws(() => investmentProjection({ principal: 1, annualReturnPercent: -5, years: 1 }), /non-negative/);
});

test('requiredMonthlySavings with zero return: simple division', () => {
  const result = requiredMonthlySavings({ targetAmount: 12000, currentSavings: 0, annualReturnPercent: 0, months: 12 });
  assert.equal(result.monthlyContributionNeeded, 1000);
});

test('requiredMonthlySavings accounts for existing savings growing at the assumed rate', () => {
  const result = requiredMonthlySavings({ targetAmount: 10000, currentSavings: 5000, annualReturnPercent: 6, months: 24 });
  assert.ok(result.monthlyContributionNeeded > 0);
  assert.ok(result.monthlyContributionNeeded < 10000 / 24, 'should need less than the zero-growth, zero-starting-savings case');
});

test('requiredMonthlySavings returns zero and a clear note when current savings already meet the target', () => {
  const result = requiredMonthlySavings({ targetAmount: 5000, currentSavings: 6000, months: 12 });
  assert.equal(result.monthlyContributionNeeded, 0);
  assert.match(result.note, /already meet or exceed/);
});

test('requiredMonthlySavings returns zero when growth alone reaches the target', () => {
  const result = requiredMonthlySavings({ targetAmount: 5100, currentSavings: 5000, annualReturnPercent: 24, months: 12 });
  assert.equal(result.monthlyContributionNeeded, 0);
});

test('requiredMonthlySavings rejects a non-integer or non-positive months value', () => {
  assert.throws(() => requiredMonthlySavings({ targetAmount: 1000, months: 0 }), /positive integer/);
  assert.throws(() => requiredMonthlySavings({ targetAmount: 1000, months: 5.5 }), /positive integer/);
});

test('calculateNetWorth: simple case with assets exceeding liabilities', () => {
  const result = calculateNetWorth(
    [{ value: 50000 }, { value: 20000 }],
    [{ value: 15000 }]
  );
  assert.equal(result.totalAssets, 70000);
  assert.equal(result.totalLiabilities, 15000);
  assert.equal(result.netWorth, 55000);
});

test('calculateNetWorth: negative net worth when liabilities exceed assets', () => {
  const result = calculateNetWorth([{ value: 5000 }], [{ value: 20000 }]);
  assert.equal(result.netWorth, -15000);
});

test('calculateNetWorth handles empty assets/liabilities arrays', () => {
  const result = calculateNetWorth([], []);
  assert.equal(result.netWorth, 0);
});

test('calculateNetWorth tolerates malformed/missing value fields rather than crashing (treats as 0)', () => {
  const result = calculateNetWorth([{ value: 'not-a-number' }, {}], [{ value: 100 }]);
  assert.equal(result.totalAssets, 0);
  assert.equal(result.netWorth, -100);
});
