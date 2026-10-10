'use strict';

const crypto = require('crypto');

const NEXT_ACTIONS = Object.freeze([
  'CONTINUE',
  'VERIFY_AGAIN',
  'RETRY',
  'REPLAN',
  'ESCALATE',
  'STOP',
]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeId(prefix = 'monitor') {
  return `${prefix}_${crypto.randomUUID()}`;
}

class AutonomousReasoner {
  constructor({ maxRetries = 1, maxReplans = 1, lowConfidence = 0.55, escalateConfidence = 0.35 } = {}) {
    this.maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.maxReplans = Math.max(0, Number(maxReplans) || 0);
    this.lowConfidence = clamp01(lowConfidence);
    this.escalateConfidence = clamp01(escalateConfidence);
  }

  decide(state, { verification = null, error = null } = {}) {
    if (!state || state.status === 'COMPLETED') return { action: 'CONTINUE', reason: 'task already completed', confidence: 1 };

    const confidence = verification && Number.isFinite(verification.confidence)
      ? clamp01(verification.confidence)
      : state.confidence;

    if (error) {
      if (state.retryCount < this.maxRetries) {
        return { action: 'RETRY', reason: 'recoverable execution failure with retry budget remaining', confidence };
      }
      if (state.replanCount < this.maxReplans) {
        return { action: 'REPLAN', reason: 'execution failure exhausted retry budget; bounded replan is available', confidence };
      }
      return { action: 'ESCALATE', reason: 'execution failure exhausted retry and replan budgets', confidence };
    }

    if (verification?.verified === false) {
      if (state.replanCount < this.maxReplans && confidence < this.escalateConfidence) {
        return { action: 'REPLAN', reason: 'verification failed with critically low confidence', confidence };
      }
      if (state.verifyCount < 1 && confidence < this.lowConfidence) {
        return { action: 'VERIFY_AGAIN', reason: 'verification is inconclusive; request one bounded independent check', confidence };
      }
      if (state.replanCount < this.maxReplans) {
        return { action: 'REPLAN', reason: 'verification failed and a bounded alternative plan is available', confidence };
      }
      return { action: 'ESCALATE', reason: 'verification failed and no autonomous recovery budget remains', confidence };
    }

    if (confidence < this.lowConfidence) {
      if (state.verifyCount < 1) return { action: 'VERIFY_AGAIN', reason: 'final result confidence is below the continuation threshold', confidence };
      return { action: 'ESCALATE', reason: 'confidence remains low after a verification pass', confidence };
    }

    if (state.anomalies.some(a => a.severity === 'HIGH')) {
      return { action: 'ESCALATE', reason: 'high-severity self-monitoring anomaly detected', confidence };
    }

    return { action: 'CONTINUE', reason: 'state is within operating thresholds', confidence };
  }
}

class VictusSelfMonitor {
  constructor({ now = () => Date.now(), historyLimit = 100, reasoner, maxSessions = 1000, sessionTtlMs = 60 * 60 * 1000 } = {}) {
    this.now = now;
    this.maxSessions = Math.max(10, maxSessions);
    this.sessionTtlMs = sessionTtlMs;
    this.historyLimit = Math.max(10, Number(historyLimit) || 100);
    this.reasoner = reasoner || new AutonomousReasoner();
    this.sessions = new Map();
    this.history = [];
  }

  begin({ taskId = safeId('task'), goal, workflow = null } = {}) {
    if (!goal || typeof goal !== 'string') throw new TypeError('goal is required');
    this._reap();
    const id = String(taskId);
    const state = {
      taskId: id,
      goal: goal.slice(0, 1000),
      workflow: workflow || null,
      status: 'RUNNING',
      stage: 'STARTED',
      startedAt: new Date(this.now()).toISOString(),
      lastUpdatedAt: new Date(this.now()).toISOString(),
      durationMs: 0,
      confidence: 0.5,
      checkpoints: [],
      signals: [],
      anomalies: [],
      decisions: [],
      retryCount: 0,
      replanCount: 0,
      verifyCount: 0,
      stepCount: 0,
      failedStepCount: 0,
      sourceCount: 0,
      toolCalls: 0,
      outputSize: 0,
      finalSuccess: null,
      finalReason: null,
    };
    this.sessions.set(id, state);
    return this._checkpoint(state, 'STARTED', {});
  }

  checkpoint(taskId, stage, data = {}) {
    const state = this._get(taskId);
    return this._checkpoint(state, stage, data);
  }

  signal(taskId, { name, value = true, severity = 'LOW', weight = 1, detail = null } = {}) {
    const state = this._get(taskId);
    const row = {
      name: String(name || 'signal'),
      value,
      severity: ['LOW', 'MEDIUM', 'HIGH'].includes(severity) ? severity : 'LOW',
      weight: Number.isFinite(weight) ? weight : 1,
      detail: detail == null ? null : String(detail).slice(0, 500),
      ts: new Date(this.now()).toISOString(),
    };
    state.signals.push(row);
    if (row.severity === 'HIGH') {
      state.anomalies.push({ type: row.name, severity: 'HIGH', detail: row.detail, ts: row.ts });
    }
    this._touch(state);
    return row;
  }

  decide(taskId, options = {}) {
    const state = this._get(taskId);
    const decision = this.reasoner.decide(state, options);
    state.decisions.push({ ...decision, ts: new Date(this.now()).toISOString() });
    if (decision.action === 'RETRY') state.retryCount += 1;
    if (decision.action === 'REPLAN') state.replanCount += 1;
    if (decision.action === 'VERIFY_AGAIN') state.verifyCount += 1;
    this._touch(state);
    return decision;
  }

  // Sessions that never completed (crashed callers) must not accumulate forever.
  _reap() {
    const cutoff = this.now() - this.sessionTtlMs;
    for (const [id, st] of this.sessions) {
      if (Date.parse(st.startedAt) < cutoff || this.sessions.size >= this.maxSessions) this.sessions.delete(id);
      else break; // Map keeps insertion order, so the rest are newer
    }
  }

  complete(taskId, { success, confidence = null, reason = null, outputSize = 0 } = {}) {
    const state = this._get(taskId);
    state.status = success ? 'COMPLETED' : 'FAILED';
    state.stage = success ? 'COMPLETED' : 'FAILED';
    state.finalSuccess = !!success;
    state.finalReason = reason == null ? null : String(reason).slice(0, 500);
    if (Number.isFinite(confidence)) state.confidence = clamp01(confidence);
    if (Number.isFinite(outputSize)) state.outputSize = outputSize;
    this._touch(state);
    const snapshot = this.snapshot(taskId);
    this.history.push(snapshot);
    while (this.history.length > this.historyLimit) this.history.shift();
    this.sessions.delete(state.taskId);
    return snapshot;
  }

  snapshot(taskId) {
    const state = this._get(taskId);
    return JSON.parse(JSON.stringify(state));
  }

  active() {
    return [...this.sessions.values()].map(state => this._publicState(state));
  }

  recent(limit = 20) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.history.slice(-n).map(row => ({ ...row }));
  }

  status() {
    const active = this.active();
    const recent = this.history.slice(-20);
    const completed = recent.filter(r => typeof r.finalSuccess === 'boolean');
    const successRate = completed.length
      ? completed.filter(r => r.finalSuccess).length / completed.length
      : null;
    const avgConfidence = recent.length
      ? recent.reduce((sum, r) => sum + clamp01(r.confidence), 0) / recent.length
      : null;
    return {
      activeTasks: active.length,
      recentTasks: recent.length,
      successRate,
      avgConfidence,
      anomalyCount: recent.reduce((n, r) => n + r.anomalies.length, 0),
      health: this._health({ successRate, avgConfidence, anomalyCount: recent.reduce((n, r) => n + r.anomalies.length, 0) }),
      active,
    };
  }

  _health({ successRate, avgConfidence, anomalyCount }) {
    if (anomalyCount > 0) return 'DEGRADED';
    if (avgConfidence != null && avgConfidence < 0.55) return 'DEGRADED';
    if (successRate != null && successRate < 0.5) return 'DEGRADED';
    if (successRate != null && successRate < 0.8) return 'WATCH';
    return 'HEALTHY';
  }

  _checkpoint(state, stage, data) {
    state.stage = String(stage || 'UNKNOWN').toUpperCase();
    state.checkpoints.push({ stage: state.stage, ts: new Date(this.now()).toISOString(), data: this._sanitize(data) });
    if (Number.isFinite(data?.stepCount)) state.stepCount = data.stepCount;
    if (Number.isFinite(data?.failedStepCount)) state.failedStepCount = data.failedStepCount;
    if (Number.isFinite(data?.sourceCount)) state.sourceCount = data.sourceCount;
    if (Number.isFinite(data?.toolCalls)) state.toolCalls = data.toolCalls;
    if (Number.isFinite(data?.confidence)) state.confidence = clamp01(data.confidence);
    if (Number.isFinite(data?.outputSize)) state.outputSize = data.outputSize;
    if (data?.anomaly) this.signal(state.taskId, data.anomaly);
    this._touch(state);
    return this._publicState(state);
  }

  _touch(state) {
    state.durationMs = Math.max(0, this.now() - new Date(state.startedAt).getTime());
    state.lastUpdatedAt = new Date(this.now()).toISOString();
  }

  _sanitize(value, depth = 0) {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 3) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, 20).map(v => this._sanitize(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value).slice(0, 30)) out[key] = this._sanitize(val, depth + 1);
      return out;
    }
    return String(value);
  }

  _publicState(state) {
    return this._sanitize(state);
  }

  _get(taskId) {
    const state = this.sessions.get(String(taskId));
    if (!state) throw new Error(`unknown monitor task: ${taskId}`);
    return state;
  }
}

module.exports = { VictusSelfMonitor, AutonomousReasoner, NEXT_ACTIONS, clamp01 };
