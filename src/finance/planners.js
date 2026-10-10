// ─── Finance Hub: Planning Calculators ────────────────────────
// Phase 10. Pure math, deterministic, no AI call — these compute using
// well-known, NAMED financial formulas/frameworks applied to numbers
// the user provides. They never recommend a specific action ("buy X",
// "you should save more") — only the arithmetic result of a named
// method, same honest boundary as invoiceMath.js in the Business Hub.

function validatePositive(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
}

// The 50/30/20 rule (Elizabeth Warren's budgeting framework): 50% needs,
// 30% wants, 20% savings/debt paydown. A real, named, well-known method
// — not an invented allocation.
function spendingPlan50_30_20(monthlyIncome) {
  validatePositive(monthlyIncome, 'monthlyIncome');
  return {
    framework: '50/30/20 rule',
    monthlyIncome,
    needs: Math.round(monthlyIncome * 0.5 * 100) / 100,
    wants: Math.round(monthlyIncome * 0.3 * 100) / 100,
    savingsOrDebt: Math.round(monthlyIncome * 0.2 * 100) / 100,
  };
}

// Future value of a lump sum + regular monthly contributions, compounded
// monthly. Standard time-value-of-money formula — this is exactly what
// any financial calculator computes, not a custom invention.
function investmentProjection({ principal = 0, monthlyContribution = 0, annualReturnPercent, years }) {
  validatePositive(principal, 'principal');
  validatePositive(monthlyContribution, 'monthlyContribution');
  validatePositive(annualReturnPercent, 'annualReturnPercent');
  validatePositive(years, 'years');

  const monthlyRate = annualReturnPercent / 100 / 12;
  const months = years * 12;

  // FV of the initial lump sum
  const fvPrincipal = principal * Math.pow(1 + monthlyRate, months);

  // FV of an ordinary annuity (the recurring monthly contributions)
  const fvContributions = monthlyRate === 0
    ? monthlyContribution * months
    : monthlyContribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);

  const totalContributed = principal + monthlyContribution * months;
  const futureValue = fvPrincipal + fvContributions;

  return {
    principal, monthlyContribution, annualReturnPercent, years,
    totalContributed: Math.round(totalContributed * 100) / 100,
    futureValue: Math.round(futureValue * 100) / 100,
    totalGrowth: Math.round((futureValue - totalContributed) * 100) / 100,
  };
}

// Required monthly contribution to reach a target amount by a target
// date, given a starting amount and an assumed annual return — solves
// the annuity formula for payment instead of future value.
function requiredMonthlySavings({ targetAmount, currentSavings = 0, annualReturnPercent = 0, months }) {
  validatePositive(targetAmount, 'targetAmount');
  validatePositive(currentSavings, 'currentSavings');
  validatePositive(annualReturnPercent, 'annualReturnPercent');
  if (typeof months !== 'number' || !Number.isInteger(months) || months <= 0) {
    throw new Error('months must be a positive integer');
  }
  if (currentSavings >= targetAmount) {
    return { targetAmount, currentSavings, monthlyContributionNeeded: 0, note: 'Current savings already meet or exceed the target.' };
  }

  const monthlyRate = annualReturnPercent / 100 / 12;
  const fvOfCurrentSavings = currentSavings * Math.pow(1 + monthlyRate, months);
  const remainingNeeded = targetAmount - fvOfCurrentSavings;

  if (remainingNeeded <= 0) {
    return { targetAmount, currentSavings, monthlyContributionNeeded: 0, note: 'Current savings are projected to reach the target through growth alone.' };
  }

  const monthlyContributionNeeded = monthlyRate === 0
    ? remainingNeeded / months
    : remainingNeeded / ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);

  return {
    targetAmount, currentSavings, months, annualReturnPercent,
    monthlyContributionNeeded: Math.round(monthlyContributionNeeded * 100) / 100,
  };
}

// Net worth is genuinely just arithmetic: what you own minus what you owe.
function calculateNetWorth(assets = [], liabilities = []) {
  const totalAssets = assets.reduce((sum, a) => sum + (Number(a.value) || 0), 0);
  const totalLiabilities = liabilities.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
  return {
    totalAssets: Math.round(totalAssets * 100) / 100,
    totalLiabilities: Math.round(totalLiabilities * 100) / 100,
    netWorth: Math.round((totalAssets - totalLiabilities) * 100) / 100,
  };
}

module.exports = { spendingPlan50_30_20, investmentProjection, requiredMonthlySavings, calculateNetWorth };
