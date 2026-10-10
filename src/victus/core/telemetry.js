'use strict';

class Telemetry {
  constructor({ maxEvents = 5000 } = {}) { this.events = []; this.maxEvents = Math.max(100, maxEvents); }

  record(event = {}) {
    const row = {
      ts: new Date().toISOString(),
      type: String(event.type || 'unknown'),
      taskId: event.taskId || null,
      durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
      success: typeof event.success === 'boolean' ? event.success : null,
      cost: Number.isFinite(event.cost) ? event.cost : null,
      quality: Number.isFinite(event.quality) ? event.quality : null,
      metadata: event.metadata || {},
    };
    this.events.push(row);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents); // bounded memory
    return row;
  }

  summarize(filter = {}) {
    const rows = this.events.filter(e => !filter.type || e.type === filter.type);
    const durations = rows.map(e => e.durationMs).filter(Number.isFinite);
    const successes = rows.filter(e => typeof e.success === 'boolean');
    const qualities = rows.map(e => e.quality).filter(Number.isFinite);
    return {
      count: rows.length,
      successRate: successes.length ? successes.filter(e => e.success).length / successes.length : null,
      avgLatencyMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      avgQuality: qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null,
      totalCost: rows.reduce((sum, e) => sum + (e.cost || 0), 0),
    };
  }
}

module.exports = { Telemetry };
