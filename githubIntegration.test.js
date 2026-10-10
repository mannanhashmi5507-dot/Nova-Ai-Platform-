const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRepoInput, fetchFileContent, listRepoTree } = require('../src/devhub/github');

test('parseRepoInput accepts "owner/repo" shorthand', () => {
  assert.deepEqual(parseRepoInput('mannanhashmi/nova-ai'), { owner: 'mannanhashmi', repo: 'nova-ai' });
});

test('parseRepoInput accepts a full github.com URL', () => {
  assert.deepEqual(parseRepoInput('https://github.com/mannanhashmi/nova-ai'), { owner: 'mannanhashmi', repo: 'nova-ai' });
});

test('parseRepoInput strips a trailing .git from a URL', () => {
  assert.deepEqual(parseRepoInput('https://github.com/mannanhashmi/nova-ai.git'), { owner: 'mannanhashmi', repo: 'nova-ai' });
});

test('parseRepoInput handles a URL with a trailing path/fragment', () => {
  assert.deepEqual(parseRepoInput('https://github.com/mannanhashmi/nova-ai/tree/main'), { owner: 'mannanhashmi', repo: 'nova-ai' });
});

test('parseRepoInput returns null for garbage input instead of throwing', () => {
  assert.equal(parseRepoInput('not a repo at all'), null);
  assert.equal(parseRepoInput(''), null);
});

function fakeFetch(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}
function fakeSafeJson(body) {
  return async () => body;
}

test('fetchFileContent decodes real base64 file content correctly', async () => {
  const fileBody = { type: 'file', encoding: 'base64', content: Buffer.from('console.log("hi")').toString('base64'), path: 'index.js', size: 18, sha: 'abc123' };
  const result = await fetchFileContent(
    { owner: 'x', repo: 'y', path: 'index.js' }, null, fakeFetch(200, fileBody), fakeSafeJson(fileBody)
  );
  assert.equal(result.content, 'console.log("hi")');
  assert.equal(result.path, 'index.js');
  assert.equal(result.sha, 'abc123');
});

test('fetchFileContent gives a clear error on 404', async () => {
  await assert.rejects(
    () => fetchFileContent({ owner: 'x', repo: 'y', path: 'missing.js' }, null, fakeFetch(404, {}), fakeSafeJson({})),
    /not found/i
  );
});

test('fetchFileContent gives a clear error on rate limit (403)', async () => {
  await assert.rejects(
    () => fetchFileContent({ owner: 'x', repo: 'y', path: 'x.js' }, null, fakeFetch(403, {}), fakeSafeJson({})),
    /rate limit|access denied/i
  );
});

test('fetchFileContent rejects when the path is actually a directory', async () => {
  const dirBody = [{ type: 'dir', path: 'src' }];
  await assert.rejects(
    () => fetchFileContent({ owner: 'x', repo: 'y', path: 'src' }, null, fakeFetch(200, dirBody), fakeSafeJson(dirBody)),
    /is a directory/
  );
});

test('listRepoTree returns only real files (blobs), not directories (trees)', async () => {
  const treeBody = { truncated: false, tree: [
    { type: 'blob', path: 'index.js', size: 100 },
    { type: 'tree', path: 'src' },
    { type: 'blob', path: 'src/app.js', size: 200 },
  ]};
  const result = await listRepoTree({ owner: 'x', repo: 'y' }, null, fakeFetch(200, treeBody), fakeSafeJson(treeBody));
  assert.equal(result.files.length, 2);
  assert.ok(result.files.every(f => f.path !== 'src'));
});

test('listRepoTree surfaces the truncated flag when GitHub reports a huge repo', async () => {
  const treeBody = { truncated: true, tree: [] };
  const result = await listRepoTree({ owner: 'x', repo: 'y' }, null, fakeFetch(200, treeBody), fakeSafeJson(treeBody));
  assert.equal(result.truncated, true);
});
