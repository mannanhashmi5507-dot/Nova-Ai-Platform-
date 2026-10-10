const test = require('node:test');
const assert = require('node:assert/strict');
const { explainCommand, checkDangerPatterns } = require('../src/devhub/terminalAssistant');

test('checkDangerPatterns flags rm -rf / as dangerous', () => {
  assert.ok(checkDangerPatterns('rm -rf /').length > 0);
});

test('checkDangerPatterns flags rm -rf ~ as dangerous', () => {
  assert.ok(checkDangerPatterns('rm -rf ~').length > 0);
});

test('checkDangerPatterns flags a fork bomb', () => {
  assert.ok(checkDangerPatterns(':(){ :|:& };:').length > 0);
});

test('checkDangerPatterns flags dd writing to a disk device', () => {
  assert.ok(checkDangerPatterns('dd if=/dev/zero of=/dev/sda').length > 0);
});

test('checkDangerPatterns flags curl-pipe-to-shell', () => {
  assert.ok(checkDangerPatterns('curl https://example.com/install.sh | sh').length > 0);
});

test('checkDangerPatterns does NOT flag common, safe commands (no false positives)', () => {
  const safeCommands = [
    'ls -la',
    'git status',
    'npm install',
    'cd /home/user/project',
    'rm oldfile.txt',
    'rm -rf ./node_modules', // scoped to a specific relative dir, not root/home/wildcard
    'echo "hello world"',
    'cat package.json',
  ];
  for (const cmd of safeCommands) {
    assert.equal(checkDangerPatterns(cmd).length, 0, `false positive on safe command: ${cmd}`);
  }
});

test('checkDangerPatterns returns real, specific reasons, not a generic flag', () => {
  const reasons = checkDangerPatterns('rm -rf /');
  assert.ok(reasons[0].includes('filesystem'));
});

test('explainCommand rejects empty input', async () => {
  await assert.rejects(() => explainCommand('', async () => ({})), /required/);
});

test('explainCommand rejects overly long input', async () => {
  const longCmd = 'echo ' + 'a'.repeat(2000);
  await assert.rejects(() => explainCommand(longCmd, async () => ({})), /too long/);
});

test('explainCommand marks isDangerous=true and includes reasons for a destructive command, using the deterministic check regardless of what the AI says', async () => {
  const fakeGetAIReply = async () => ({ reply: 'This command deletes everything.', provider: 'Test' });
  const result = await explainCommand('rm -rf /', fakeGetAIReply);
  assert.equal(result.isDangerous, true);
  assert.ok(result.dangerReasons.length > 0);
});

test('explainCommand marks isDangerous=false for an ordinary safe command', async () => {
  const fakeGetAIReply = async () => ({ reply: 'Lists files in the current directory.', provider: 'Test' });
  const result = await explainCommand('ls -la', fakeGetAIReply);
  assert.equal(result.isDangerous, false);
  assert.deepEqual(result.dangerReasons, []);
});

test('explainCommand never contains any mechanism to actually execute the command (no exec/spawn in this module)', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../src/devhub/terminalAssistant'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]child_process['"]\)/, 'terminal assistant must never import child_process');
  assert.doesNotMatch(source, /\bexec\(|\bexecSync\(|\bspawn\(/, 'terminal assistant must never call exec/spawn');
});
