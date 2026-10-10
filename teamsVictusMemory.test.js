const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { buildAdaptiveContext } = require('../src/victus/adaptive');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

test('REGRESSION: a user in no organization gets IDENTICAL output to before Phase 14 (empty string, no org section)', async () => {
  await withMockedDb({
    isEnabled: () => true,
    getPreferences: async () => [],
    getFeedbackScore: async () => ({ total: 0, positive: 0 }),
    getUserOrgPreferences: async () => [], // the Phase 14 addition, returning nothing for a non-org user
  }, async () => {
    const result = await buildAdaptiveContext(42, 'hello');
    assert.equal(result, '', 'must be exactly the same empty-string behavior as before this phase');
  });
});

test('REGRESSION: a non-org user with personal preferences still gets exactly the personal-preferences text, no org section', async () => {
  await withMockedDb({
    isEnabled: () => true,
    getPreferences: async () => [{ pref_key: 'tone', pref_value: 'casual' }],
    getFeedbackScore: async () => ({ total: 0, positive: 0 }),
    getUserOrgPreferences: async () => [],
  }, async () => {
    const result = await buildAdaptiveContext(42, 'tone question');
    assert.match(result, /Known user preferences/);
    assert.doesNotMatch(result, /Shared team preferences/, 'no org section should appear for a non-org user');
  });
});

test('a user IN an organization with shared preferences gets a real "Shared team preferences" section', async () => {
  await withMockedDb({
    isEnabled: () => true,
    getPreferences: async () => [],
    getFeedbackScore: async () => ({ total: 0, positive: 0 }),
    getUserOrgPreferences: async () => [{ pref_key: 'brand_voice', pref_value: 'casual and friendly' }],
  }, async () => {
    const result = await buildAdaptiveContext(42, 'write something');
    assert.match(result, /Shared team preferences/);
    assert.match(result, /brand_voice: casual and friendly/);
  });
});

test('shared team preferences appear BEFORE personal preferences in the combined context', async () => {
  await withMockedDb({
    isEnabled: () => true,
    getPreferences: async () => [{ pref_key: 'personal_pref', pref_value: 'x' }],
    getFeedbackScore: async () => ({ total: 0, positive: 0 }),
    getUserOrgPreferences: async () => [{ pref_key: 'team_pref', pref_value: 'y' }],
  }, async () => {
    const result = await buildAdaptiveContext(42, 'question');
    const teamIdx = result.indexOf('Shared team preferences');
    const personalIdx = result.indexOf('Known user preferences');
    assert.ok(teamIdx < personalIdx && teamIdx !== -1 && personalIdx !== -1);
  });
});
