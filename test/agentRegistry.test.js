const test = require('node:test');
const assert = require('node:assert/strict');
const { PERSONAS, listPersonas, getPersona } = require('../src/agents/registry');

test('exactly the 8 personas from the roadmap exist', () => {
  const keys = Object.keys(PERSONAS);
  assert.equal(keys.length, 8);
  for (const expected of ['research', 'coding', 'business', 'marketing', 'finance', 'tutor', 'travel', 'personal_assistant']) {
    assert.ok(keys.includes(expected), `missing persona: ${expected}`);
  }
});

test('every persona has a key, name, description, systemPrompt, and tools array', () => {
  for (const persona of Object.values(PERSONAS)) {
    assert.ok(persona.key);
    assert.ok(persona.name);
    assert.ok(persona.description);
    assert.ok(persona.systemPrompt && persona.systemPrompt.length > 20);
    assert.ok(Array.isArray(persona.tools));
  }
});

test('every tool referenced by a persona is a real, known tool', () => {
  const KNOWN_TOOLS = ['calculator', 'webSearch'];
  for (const persona of Object.values(PERSONAS)) {
    for (const toolKey of persona.tools) {
      assert.ok(KNOWN_TOOLS.includes(toolKey), `${persona.key} references unknown tool: ${toolKey}`);
    }
  }
});

test('finance persona system prompt includes an explicit non-advice disclaimer', () => {
  const finance = getPersona('finance');
  assert.match(finance.systemPrompt, /not a licensed financial advisor|educational/i);
});

test('personas without real integrations (marketing, travel, business, personal_assistant) are honest about not having them', () => {
  // Every persona whose domain implies an external system (posting to
  // social media, booking travel, accessing a CRM/calendar) must say so
  // plainly rather than implying it can perform that action.
  const domainsWithNoRealIntegration = ['business', 'marketing', 'travel', 'personal_assistant'];
  for (const key of domainsWithNoRealIntegration) {
    const persona = getPersona(key);
    assert.match(
      persona.systemPrompt,
      /do not have access|cannot actually|does not exist yet|do not fabricate/i,
      `${key} persona should disclose it lacks real integration, not imply it has one`
    );
  }
});

test('listPersonas returns public-safe fields only (no internal system prompt leaked)', () => {
  const list = listPersonas();
  assert.equal(list.length, 8);
  for (const p of list) {
    assert.ok(p.key && p.name && p.description);
    assert.equal(p.systemPrompt, undefined, 'system prompts should not be exposed via the public listing endpoint');
  }
});

test('getPersona returns null for an unknown key instead of throwing', () => {
  assert.equal(getPersona('not-a-real-agent'), null);
});
