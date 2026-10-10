'use strict';

const { ACTION_TYPES } = require('./contracts');
const { HIGH_RISK_ACTIONS } = require('./policy');

class ToolBus {
  constructor({ policy } = {}) {
    this.tools = new Map();
    this.policy = policy || { isAllowed: () => true };
  }

  register(definition) {
    validateTool(definition);
    if (this.tools.has(definition.toolId)) throw new Error(`tool already registered: ${definition.toolId}`);
    this.tools.set(definition.toolId, Object.freeze({
      riskLevel: 'LOW',
      timeoutMs: 10000,
      resourceLimits: { maxOutputBytes: 1024 * 1024 },
      ...definition,
    }));
  }

  get(toolId) { return this.tools.get(toolId) || null; }

  list() { return [...this.tools.values()].map(t => ({ ...t, execute: undefined })); }

  async execute(toolId, input, context = {}) {
    const tool = this.get(toolId);
    if (!tool) throw new Error(`unknown tool: ${toolId}`);
    const allowed = await this.policy.isAllowed({ tool, input, context });
    if (!allowed) throw new Error(`tool denied by policy: ${toolId}`);
    // High-risk actions are never run on the model's say-so: the (server-built) context
    // must carry an explicit human approval.
    if (HIGH_RISK_ACTIONS.includes(tool.actionType) && context.humanApproval !== true) {
      throw new Error(`tool requires human approval: ${toolId}`);
    }
    await checkConditions(tool.preconditions, { input, context, phase: 'precondition' });
    const started = Date.now();
    const result = await withTimeout(tool.execute(input, context), tool.timeoutMs, toolId);
    const maxBytes = tool.resourceLimits?.maxOutputBytes;
    if (Number.isFinite(maxBytes)) {
      let size = 0;
      try { size = JSON.stringify(result === undefined ? null : result).length; } catch { throw new Error(`tool output is not serializable: ${toolId}`); }
      if (size > maxBytes) throw new Error(`tool output exceeds ${maxBytes} bytes: ${toolId}`);
    }
    await checkConditions(tool.postconditions, { input, context, result, phase: 'postcondition' });
    return { toolId, durationMs: Date.now() - started, result };
  }
}

async function checkConditions(conditions, payload) {
  for (const condition of conditions) {
    if (typeof condition === 'function') {
      if (!(await condition(payload))) throw new Error(`${payload.phase} failed`);
      continue;
    }
    if (typeof condition === 'string') {
      const value = resolvePath(payload, condition);
      if (!value) throw new Error(`${payload.phase} failed: ${condition}`);
      continue;
    }
    if (!condition || typeof condition !== 'object') throw new TypeError('tool conditions must be functions, paths, or objects');
    if (condition.path && !resolvePath(payload, condition.path)) throw new Error(`${payload.phase} failed: ${condition.path}`);
  }
}

function resolvePath(obj, path) {
  return String(path).split('.').reduce((acc, key) => acc == null ? undefined : acc[key], obj);
}

function withTimeout(promise, timeoutMs, toolId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool timeout: ${toolId}`)), timeoutMs);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function validateTool(t) {
  if (!t || typeof t !== 'object') throw new TypeError('tool definition must be an object');
  if (!t.toolId || typeof t.toolId !== 'string') throw new TypeError('toolId is required');
  if (!t.description) throw new TypeError('description is required');
  for (const key of ['preconditions', 'postconditions', 'permissions']) {
    if (!Array.isArray(t[key])) throw new TypeError(`${key} must be an array`);
  }
  if (!ACTION_TYPES.includes(t.actionType || 'EXECUTE')) throw new TypeError(`invalid actionType: ${t.actionType}`);
  if (t.timeoutMs != null && (!Number.isInteger(t.timeoutMs) || t.timeoutMs <= 0)) throw new TypeError('timeoutMs must be a positive integer');
  if (typeof t.execute !== 'function') throw new TypeError('execute handler is required');
}

module.exports = { ToolBus, validateTool, checkConditions, withTimeout };
