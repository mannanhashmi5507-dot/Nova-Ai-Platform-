const test = require('node:test');
const assert = require('node:assert/strict');
const { rankPreferencesByRelevance, tokenize } = require('../src/victus/memoryRetrieval');

function pref(key, value) { return { pref_key: key, pref_value: value }; }

test('tokenize strips stopwords and short/punctuation-only tokens', () => {
  const tokens = tokenize('What is the current price of gold in Pakistan?');
  assert.ok(tokens.includes('current'));
  assert.ok(tokens.includes('price'));
  assert.ok(tokens.includes('gold'));
  assert.ok(tokens.includes('pakistan'));
  assert.ok(!tokens.includes('is'));
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('of'));
});

test('ranks a directly relevant preference above an unrelated one', () => {
  const prefs = [
    pref('hobby', 'collects vintage cameras'),
    pref('coding_language', 'prefers JavaScript over Python'),
  ];
  const result = rankPreferencesByRelevance(prefs, 'Can you help me fix this JavaScript bug?');
  assert.equal(result[0].pref_key, 'coding_language');
});

test('excludes preferences with zero keyword overlap when at least one preference matches', () => {
  const prefs = [
    pref('favorite_food', 'loves biryani'),
    pref('coding_language', 'prefers JavaScript'),
  ];
  const result = rankPreferencesByRelevance(prefs, 'help me debug my JavaScript function');
  assert.equal(result.length, 1);
  assert.equal(result[0].pref_key, 'coding_language');
});

test('falls back to recency (not empty) when nothing matches at all', () => {
  const prefs = [
    pref('favorite_food', 'loves biryani'),
    pref('hobby', 'plays chess'),
  ];
  const result = rankPreferencesByRelevance(prefs, 'xyzzy qux nonsense query with no overlap');
  assert.equal(result.length, 2, 'should fall back to recent preferences rather than returning nothing');
});

test('returns empty array when there are no stored preferences at all', () => {
  const result = rankPreferencesByRelevance([], 'anything');
  assert.deepEqual(result, []);
});

test('respects maxResults even when many preferences are relevant', () => {
  const prefs = Array.from({ length: 10 }, (_, i) => pref(`topic_${i}`, 'javascript coding preference'));
  const result = rankPreferencesByRelevance(prefs, 'help with javascript coding', 3);
  assert.equal(result.length, 3);
});
