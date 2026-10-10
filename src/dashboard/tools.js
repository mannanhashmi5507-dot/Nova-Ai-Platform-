// ─── Known tools registry ────────────────────────────────────
// Static, code-defined list of tools nova-ai actually has right now.
// Deliberately NOT a database table — the set of tools ships with the
// code, so it should version with the code. user_favorite_tools just
// stores which tool_key values a user has starred.
//
// IMPORTANT: keep this list honest. Only list things that actually
// exist and work today. Add a row here the same PR you ship the
// feature, not before.

const TOOLS = [
  { key: 'chat',        name: 'Chat',              description: 'Chat with Groq, Gemini, or ChatGPT',        route: '/api/chat' },
  { key: 'chat.victor', name: 'Victor',             description: 'Multi-stage draft → validate → refine pipeline', route: '/api/chat' },
  { key: 'agent',       name: 'Nova Agent',         description: 'Tool-using agent: calculator + live web search', route: '/api/agent' },
  { key: 'dev.explain', name: 'Explain Code',       description: 'Understand what a piece of code does',      route: '/api/dev/code' },
  { key: 'dev.fix',     name: 'Fix Code',           description: 'Find and fix a bug',                        route: '/api/dev/code' },
  { key: 'dev.review',  name: 'Review Code',        description: 'Get a structured code review',              route: '/api/dev/code' },
  { key: 'dev.refactor',name: 'Refactor Code',      description: 'Improve code without changing behavior',    route: '/api/dev/code' },
  { key: 'dev.docs',    name: 'Generate Docs',      description: 'Add documentation to real code',            route: '/api/dev/code' },
  { key: 'image',       name: 'Image Generation',   description: 'Generate images (Pollinations)',            route: '/api/image' },
];

const TOOL_KEYS = TOOLS.map(t => t.key);

function isValidToolKey(key) {
  return TOOL_KEYS.includes(key);
}

module.exports = { TOOLS, TOOL_KEYS, isValidToolKey };
