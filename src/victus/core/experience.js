'use strict';

// Phase 9: experience learning. Records plan outcomes per task family and
// ranks candidate workflows by smoothed success, speed and recency. No model
// retraining; the learning state is plain data the control plane owns.

const { tokenize } = require('./ranking');

function familyOf(goal) {
  const t = tokenize(goal).slice(0, 4).sort();
  return t.length ? t.join('-') : 'general';
}

class ExperienceStore {
  constructor({ halfLifeMs = 14 * 24 * 3600 * 1000, now = () => Date.now(), maxRecords = 5000 } = {}) {
    this.maxRecords = Math.max(100, maxRecords);
    this.halfLifeMs = halfLifeMs;
    this.now = now;
    this.records = []; // { family, workflow, success, durationMs, cost, ts }
  }

  record({ goal, family, workflow, success, durationMs = null, cost = 0 }) {
    if (!workflow) throw new TypeError('workflow is required');
    const row = { family: family || familyOf(goal), workflow, success: !!success, durationMs, cost, ts: this.now() };
    this.records.push(row);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords); // oldest evidence ages out
    return row;
  }

  // Recency-weighted Beta(1,1)-smoothed success rate, so one lucky run
  // can't outrank a long track record.
  stats(family, workflow) {
    let wins = 0, losses = 0, runs = 0, dur = 0, durN = 0;
    for (const r of this.records) {
      if (r.family !== family || r.workflow !== workflow) continue;
      const w = Math.pow(0.5, (this.now() - r.ts) / this.halfLifeMs);
      if (r.success) wins += w; else losses += w;
      runs += 1;
      if (Number.isFinite(r.durationMs)) { dur += r.durationMs; durN += 1; }
    }
    return { runs, score: (wins + 1) / (wins + losses + 2), avgDurationMs: durN ? dur / durN : null };
  }

  rank(goalOrFamily, workflows, { explore = 0.05 } = {}) {
    const family = this.records.some(r => r.family === goalOrFamily) ? goalOrFamily : familyOf(goalOrFamily);
    return workflows
      .map(w => {
        const s = this.stats(family, w);
        const bonus = explore / Math.sqrt(1 + s.runs); // favour under-tried options slightly
        return { workflow: w, ...s, rankScore: s.score + bonus };
      })
      .sort((a, b) => b.rankScore - a.rankScore);
  }

  best(goal, workflows) { return this.rank(goal, workflows)[0] || null; }
}

module.exports = { ExperienceStore, familyOf };
