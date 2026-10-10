// ─── Developer Hub: Terminal Assistant ───────────────────────
// Phase 6. HONEST SCOPE, stated plainly: this does NOT execute shell
// commands. An HTTP endpoint that runs arbitrary shell commands on a
// server is a remote-code-execution vector — that's not a feature to
// build carefully, it's a feature not to build. What ships instead is
// a real, safe capability: explain what a command does, flag destructive
// ones, and suggest safer alternatives, using the same AI providers
// already wired up. No process spawning, no exec, no shell access
// anywhere in this file.

// Deterministic, zero-AI-call danger detection for the most common
// destructive patterns — checked BEFORE calling the AI, so a dangerous
// command gets flagged even if the AI explanation call fails.
const DANGER_PATTERNS = [
  { pattern: /rm\s+-rf\s+\/(?!\S)/,          reason: 'deletes the entire filesystem root' },
  { pattern: /rm\s+-rf\s+~/,                  reason: 'deletes the entire home directory' },
  { pattern: /rm\s+-rf\s+\*/,                 reason: 'recursively deletes everything in the current directory' },
  { pattern: /:\(\)\{.*\|.*&.*\};:/,           reason: 'fork bomb — will exhaust system resources' },
  { pattern: /dd\s+if=.*of=\/dev\/(sd|nvme)/,  reason: 'writes raw data directly to a disk device — can destroy all data on it' },
  { pattern: /chmod\s+-R\s+777\s+\//,          reason: 'makes the entire filesystem world-writable — serious security risk' },
  { pattern: />\s*\/dev\/sd[a-z]/,             reason: 'writes directly to a disk device' },
  { pattern: /mkfs\./,                         reason: 'formats a filesystem — destroys existing data on that device/partition' },
  { pattern: /curl.*\|\s*(ba)?sh/,             reason: 'pipes a downloaded script directly into a shell — runs arbitrary remote code unreviewed' },
  { pattern: /wget.*\|\s*(ba)?sh/,             reason: 'pipes a downloaded script directly into a shell — runs arbitrary remote code unreviewed' },
];

function checkDangerPatterns(command) {
  const matches = DANGER_PATTERNS.filter(({ pattern }) => pattern.test(command));
  return matches.map(m => m.reason);
}

async function explainCommand(command, getAIReply, signal) {
  if (!command || typeof command !== 'string' || !command.trim()) {
    throw new Error('command is required');
  }
  if (command.length > 1000) {
    throw new Error('command too long (max 1000 characters)');
  }

  const dangerReasons = checkDangerPatterns(command);

  const messages = [
    {
      role: 'system',
      content: `Explain this shell command clearly: what it does, what each flag/argument means, and what its effects would be if run. If it is destructive, irreversible, or commonly mistyped in a dangerous way, say so explicitly and suggest a safer alternative or a dry-run flag if one exists. You are explaining ONLY — you are not running anything and have no ability to.`
    },
    { role: 'user', content: `Explain this command:\n\`${command}\`` }
  ];

  const { reply, provider } = await getAIReply(messages, 'auto', signal);

  return {
    command,
    explanation: reply.trim(),
    isDangerous: dangerReasons.length > 0,
    dangerReasons, // populated by deterministic pattern match, not the AI — so this is trustworthy even if the AI explanation is imperfect
    provider,
  };
}

module.exports = { explainCommand, checkDangerPatterns };
