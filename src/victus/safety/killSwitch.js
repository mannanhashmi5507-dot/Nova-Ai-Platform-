'use strict';

// Fail-closed kill switch. Scope "all" stops everything; narrower scopes stop
// one capability. Releasing a narrow scope can never lift an "all" stop.
// State can be persisted so a restart does not silently re-enable Victus.

const fs = require('fs');
const path = require('path');
const { KillSwitchEngagedError, ValidationError } = require('./errors');

const SCOPES = Object.freeze(['all', 'research', 'internet', 'memory', 'proposals', 'coding', 'compute']);

class KillSwitch {
  constructor({ stateFile = null, initiallyEngaged = false, audit = null, now = () => new Date() } = {}) {
    this.stateFile = stateFile;
    this.audit = audit;
    this.now = now;
    this.engaged = new Map();
    if (stateFile) this._load();
    if (initiallyEngaged && !this.engaged.has('all')) this._set('all', { by: 'system', reason: 'engaged at startup via environment' });
  }

  _set(scope, info) {
    this.engaged.set(scope, { ...info, at: this.now().toISOString() });
    this._save();
  }

  _load() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [scope, info] of Object.entries(data.engaged || {})) if (SCOPES.includes(scope)) this.engaged.set(scope, info);
    } catch (err) {
      // An unreadable state file must not mean "everything is fine".
      this.engaged.set('all', { by: 'system', reason: `safety state unreadable: ${err.message}`, at: this.now().toISOString() });
    }
  }

  _save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ engaged: Object.fromEntries(this.engaged) }));
      this.persistError = null;
    } catch (err) {
      // In-memory state still holds for this process, but a restart would forget the stop. Say so.
      this.persistError = err.message;
    }
  }

  engage({ by, reason = '', scope = 'all' } = {}) {
    if (!SCOPES.includes(scope)) throw new ValidationError(`scope must be one of: ${SCOPES.join(', ')}`);
    if (!by) throw new ValidationError('actor is required');
    this._set(scope, { by: String(by), reason: String(reason).slice(0, 500) });
    this.audit?.append({ actor: by, action: 'killswitch.engaged', target: scope, metadata: { reason } });
    return this.status();
  }

  release({ by, scope = 'all' } = {}) {
    if (!SCOPES.includes(scope)) throw new ValidationError(`scope must be one of: ${SCOPES.join(', ')}`);
    if (!by) throw new ValidationError('actor is required');
    if (scope === 'all') this.engaged.clear(); else this.engaged.delete(scope);
    this._save();
    this.audit?.append({ actor: by, action: 'killswitch.released', target: scope });
    return this.status();
  }

  isEngaged(scope = 'all') { return this.engaged.has('all') || this.engaged.has(scope); }

  assertRunning(scope = 'all') {
    if (this.isEngaged(scope)) throw new KillSwitchEngagedError(scope);
  }

  status() {
    return { engaged: this.engaged.size > 0, scopes: Object.fromEntries(this.engaged), persisted: !!this.stateFile && !this.persistError, persistError: this.persistError || null };
  }
}

module.exports = { KillSwitch, SCOPES };
