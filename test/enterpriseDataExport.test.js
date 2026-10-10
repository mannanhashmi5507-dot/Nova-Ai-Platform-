const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { exportUserData } = require('../src/enterprise/dataExport');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

const baseMocks = {
  listConversations: async () => ({ items: [] }),
  listNotes: async () => [], listTasks: async () => [], listProjects: async () => [],
  listCustomers: async () => [], listInvoices: async () => [], listGoals: async () => [], listFinancialGoals: async () => [],
};

test('exportUserData aggregates data from every real source', async () => {
  await withMockedDb({
    listConversations: async () => ({ items: [{ id: 'c1', title: 'Test' }] }),
    listNotes: async () => [{ id: 1, title: 'Note' }],
    listTasks: async () => [{ id: 1, title: 'Task' }],
    listProjects: async () => [{ id: 1, name: 'Project' }],
    listCustomers: async () => [{ id: 1, name: 'Customer' }],
    listInvoices: async () => [{ id: 1, invoice_number: 'INV-1' }],
    listGoals: async () => [{ id: 1, name: 'Goal' }],
    listFinancialGoals: async () => [{ id: 1, name: 'FinGoal' }],
  }, async () => {
    const result = await exportUserData(42);
    assert.equal(result.userId, 42);
    assert.ok(result.exportedAt);
    assert.equal(result.data.conversations.length, 1);
    assert.equal(result.data.notes.length, 1);
    assert.equal(result.data.financialGoals.length, 1);
  });
});

test('exportUserData is honest that this is not a full database backup', async () => {
  await withMockedDb(baseMocks, async () => {
    const result = await exportUserData(1);
    assert.match(result.note, /not a full database backup/);
  });
});

test('exportUserData handles a user with zero data without error', async () => {
  await withMockedDb(baseMocks, async () => {
    const result = await exportUserData(1);
    assert.equal(result.data.conversations.length, 0);
  });
});

test('exportedAt is a real, valid, current-ish ISO timestamp', async () => {
  await withMockedDb(baseMocks, async () => {
    const before = Date.now();
    const result = await exportUserData(1);
    const exportedTime = new Date(result.exportedAt).getTime();
    assert.ok(exportedTime >= before && exportedTime <= Date.now() + 1000);
  });
});
