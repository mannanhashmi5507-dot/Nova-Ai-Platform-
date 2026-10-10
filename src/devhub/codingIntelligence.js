'use strict';

// Victus coding intelligence: deterministic preflight analysis that gives the
// language model a much better map of the code before it proposes changes.
// This deliberately does not execute user code. It inspects source text only.

const LANGUAGE_PATTERNS = [
  ['typescript', [/\binterface\s+\w+\s*\{/, /:\s*(string|number|boolean|unknown|any)\b/, /<\w+>\s*\(/]],
  ['javascript', [/\b(function|const|let|var|class)\b/, /=>/, /require\(['"]/]],
  ['python', [/^\s*def\s+\w+\s*\(/m, /^\s*class\s+\w+\s*:/m, /\b(import|from)\s+\w+/]],
  ['java', [/\bpublic\s+(class|static|final)\b/, /System\.out\.println/, /\bimport\s+java\./]],
  ['csharp', [/\busing\s+System/, /\bpublic\s+(class|async|static)\b/, /Console\.WriteLine/]],
  ['go', [/^\s*package\s+\w+/m, /\bfunc\s+\w+\s*\(/, /:=/]],
  ['rust', [/\bfn\s+\w+\s*\(/, /\blet\s+mut\b/, /\bimpl\s+\w+/]],
  ['php', [/<\?php/, /\$[A-Za-z_]\w*\s*=/]],
  ['ruby', [/^\s*def\s+\w+/m, /\bend\s*$/m, /\bputs\b/]],
  ['sql', [/\bSELECT\b[\s\S]*\bFROM\b/i, /\bCREATE\s+TABLE\b/i, /\bUPDATE\b[\s\S]*\bSET\b/i]],
];

const RISK_PATTERNS = [
  { name: 'command-execution', severity: 'HIGH', pattern: /\b(child_process|execSync|spawnSync|subprocess|os\.system|shell=True)\b/i },
  { name: 'dynamic-code', severity: 'HIGH', pattern: /\beval\s*\(|\bnew\s+Function\s*\(/i },
  { name: 'credentials', severity: 'HIGH', pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'unsafe-html', severity: 'MEDIUM', pattern: /\b(innerHTML|dangerouslySetInnerHTML)\b/ },
  { name: 'sql-concatenation', severity: 'MEDIUM', pattern: /(?:[\"'`])\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^\"'`]*(?:[\"'`]\s*\+|\$\{)/i },
  { name: 'weak-randomness', severity: 'MEDIUM', pattern: /(?:\bMath\.random\s*\(|\brand\s*\()/i },
  { name: 'debug-output', severity: 'LOW', pattern: /(?:\bconsole\.log\s*\(|(?:^|[^\w])print\s*\()/m },
];

function detectLanguage(code, hint) {
  if (hint && typeof hint === 'string' && hint.trim()) return hint.trim().toLowerCase();
  const text = String(code || '');
  const scores = LANGUAGE_PATTERNS.map(([name, patterns]) => ({
    name,
    score: patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 ? scores[0].name : 'unknown';
}

function lineCount(code) {
  return String(code || '').split(/\r?\n/).length;
}

function estimateComplexity(code) {
  const text = String(code || '');
  const lines = lineCount(text);
  const branches = (text.match(/\b(if|else if|switch|case|for|while|catch|match)\b/g) || []).length;
  const functions = (text.match(/\b(function|def|func|fn)\b/g) || []).length;
  const classes = (text.match(/\b(class|struct|interface|trait)\b/g) || []).length;
  const complexityScore = Math.min(100, lines * 0.35 + branches * 2.8 + functions * 1.8 + classes * 3);
  const level = complexityScore >= 55 ? 'high' : complexityScore >= 25 ? 'moderate' : 'low';
  return { score: Number(complexityScore.toFixed(1)), level, lines, branches, functions, classes };
}

function findSymbols(code, language) {
  const text = String(code || '');
  const symbols = [];
  const patterns = language === 'python'
    ? [/^\s*(?:async\s+)?def\s+(\w+)/gm, /^\s*class\s+(\w+)/gm]
    : [/\b(?:async\s+)?function\s+(\w+)\s*\(/g, /\bclass\s+(\w+)/g, /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) symbols.push(match[1]);
  }
  return [...new Set(symbols)].slice(0, 100);
}

function securityFindings(code) {
  const text = String(code || '');
  return RISK_PATTERNS
    .filter(item => item.pattern.test(text))
    .map(item => ({ name: item.name, severity: item.severity }));
}

function buildCodingContext({ code, language, mode, extra = {} } = {}) {
  const source = String(code || '');
  const detectedLanguage = detectLanguage(source, language);
  const complexity = estimateComplexity(source);
  const findings = securityFindings(source);
  const symbols = findSymbols(source, detectedLanguage);
  return {
    mode,
    language: detectedLanguage,
    lines: complexity.lines,
    complexity,
    symbols,
    securityFindings: findings,
    hasTestsHint: /\b(test|describe|it\(|pytest|unittest|jest|mocha|vitest)\b/i.test(source),
    hasAsync: /\b(async|await|Promise|Future|goroutine)\b/i.test(source),
    extra: extra || {},
  };
}

function formatCodingContext(context) {
  const risk = context.securityFindings.length
    ? context.securityFindings.map(f => `${f.name}:${f.severity}`).join(', ')
    : 'none detected by deterministic preflight';
  return [
    'Victus coding preflight:',
    `- detected language: ${context.language}`,
    `- size: ${context.lines} lines`,
    `- complexity: ${context.complexity.level} (${context.complexity.score})`,
    `- symbols: ${context.symbols.length ? context.symbols.join(', ') : 'none confidently detected'}`,
    `- async/concurrency signals: ${context.hasAsync ? 'yes' : 'no'}`,
    `- test signals: ${context.hasTestsHint ? 'present' : 'not detected'}`,
    `- security signals: ${risk}`,
  ].join('\n');
}

module.exports = {
  detectLanguage,
  estimateComplexity,
  findSymbols,
  securityFindings,
  buildCodingContext,
  formatCodingContext,
};
