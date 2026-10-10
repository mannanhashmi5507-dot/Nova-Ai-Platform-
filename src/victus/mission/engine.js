'use strict';

const crypto = require('crypto');

const MISSION_STATES = Object.freeze(['DRAFT', 'READY', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const TASK_STATES = Object.freeze(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const TERMINAL_MISSION_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL_TASK_STATES = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const MAX_MISSION_NAME = 240;
const MAX_GOAL = 4000;
const MAX_TASKS = 100;
const MAX_TASK_ID = 160;
const MAX_ACTION = 120;
const MAX_DESCRIPTION = 500;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RUN_TASK_EXECUTIONS = 500;

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

function requiredString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const out = value.trim();
  if (max && out.length > max) throw new RangeError(`${field} exceeds ${max} characters`);
  return out;
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeJson(value, field, maxBytes, fallback = {}) {
  const input = value == null ? fallback : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${field} must be an object`);
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new RangeError(`${field} exceeds ${maxBytes} bytes`);
  return JSON.parse(encoded);
}

function normalizeTask(input = {}, position = 0) {
  const task = {
    id: input.id ? requiredString(input.id, 'task.id', MAX_TASK_ID) : id('task'),
    description: requiredString(input.description || input.action || `Mission task ${position + 1}`, 'task.description', MAX_DESCRIPTION),
    action: requiredString(input.action, 'task.action', MAX_ACTION),
    input: safeJson(input.input, 'task.input', MAX_INPUT_BYTES),
    dependsOn: Array.isArray(input.dependsOn) ? [...new Set(input.dependsOn.map(v => requiredString(v, 'task.dependsOn', MAX_TASK_ID)))] : [],
    priority: boundedInt(input.priority, 0, -100, 100),
    recoveryStrategy: ['stop', 'retry', 'skip'].includes(input.recoveryStrategy) ? input.recoveryStrategy : 'stop',
    maxAttempts: boundedInt(input.maxAttempts, 3, 1, 5),
    requiresApproval: input.requiresApproval === true,
    requiresVerification: input.requiresVerification !== false,
    status: 'PENDING',
    attempts: 0,
    result: null,
    error: null,
    verification: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (task.dependsOn.includes(task.id)) throw new TypeError(`task ${task.id} cannot depend on itself`);
  return task;
}

function detectCycles(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId, chain = []) {
    if (visiting.has(taskId)) throw new TypeError(`mission task dependency cycle: ${[...chain, taskId].join(' -> ')}`);
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) throw new TypeError(`unknown task dependency: ${taskId}`);
    visiting.add(taskId);
    for (const dep of task.dependsOn) visit(dep, [...chain, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);
}

function normalizeMission(input = {}, tenantId) {
  const tenant = requiredString(tenantId, 'tenantId', 240);
  const tasksInput = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasksInput.length < 1) throw new TypeError('mission requires at least one task');
  if (tasksInput.length > MAX_TASKS) throw new RangeError(`mission cannot contain more than ${MAX_TASKS} tasks`);
  const tasks = tasksInput.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new TypeError(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  detectCycles(tasks);
  const mission = {
    id: input.id ? requiredString(input.id, 'mission.id', 160) : id('mission'),
    tenantId: tenant,
    name: requiredString(input.name || input.goal, 'mission.name', MAX_MISSION_NAME),
    goal: requiredString(input.goal, 'mission.goal', MAX_GOAL),
    constraints: safeJson(input.constraints, 'mission.constraints', MAX_INPUT_BYTES),
    metadata: safeJson(input.metadata, 'mission.metadata', MAX_INPUT_BYTES),
    status: 'READY',
    tasks,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
  };
  return mission;
}

class InMemoryMissionRepository {
  constructor() { this.missions = new Map(); }
  async create(mission) { const key = `${mission.tenantId}:${mission.id}`; if (this.missions.has(key)) throw new Error('mission already exists'); this.missions.set(key, structuredClone(mission)); return structuredClone(mission); }
  async save(mission) { const key = `${mission.tenantId}:${mission.id}`; if (!this.missions.has(key)) throw new Error('mission not found'); mission.version += 1; mission.updatedAt = new Date().toISOString(); this.missions.set(key, structuredClone(mission)); return structuredClone(mission); }
  async get(tenantId, idValue) { const row = this.missions.get(`${tenantId}:${idValue}`); return row ? structuredClone(row) : null; }
  async list(tenantId, { status, limit = 50 } = {}) {
    return [...this.missions.values()].filter(m => m.tenantId === tenantId && (!status || m.status === status)).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit).map(structuredClone);
  }
}

class PostgresMissionRepository {
  constructor(pool) { if (!pool) throw new Error('Postgres pool is required'); this.pool = pool; }
  async create(mission) {
    const { rows } = await this.pool.query(
      `INSERT INTO victus_missions (id, tenant_id, name, goal, status, constraints, metadata, tasks, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [mission.id, mission.tenantId, mission.name, mission.goal, mission.status, JSON.stringify(mission.constraints), JSON.stringify(mission.metadata), JSON.stringify(mission.tasks), mission.version, mission.createdAt, mission.updatedAt]
    );
    return mapMission(rows[0]);
  }
  async save(mission) {
    const nextVersion = mission.version + 1;
    const { rows } = await this.pool.query(
      `UPDATE victus_missions SET name=$1, goal=$2, status=$3, constraints=$4, metadata=$5, tasks=$6, version=$7, updated_at=now(), started_at=$8, completed_at=$9
       WHERE tenant_id=$10 AND id=$11 AND version=$12 RETURNING *`,
      [mission.name, mission.goal, mission.status, JSON.stringify(mission.constraints), JSON.stringify(mission.metadata), JSON.stringify(mission.tasks), nextVersion, mission.startedAt, mission.completedAt, mission.tenantId, mission.id, mission.version]
    );
    if (!rows[0]) throw new Error('mission update conflict or not found');
    return mapMission(rows[0]);
  }
  async get(tenantId, idValue) {
    const { rows } = await this.pool.query(`SELECT * FROM victus_missions WHERE tenant_id=$1 AND id=$2`, [tenantId, idValue]);
    return rows[0] ? mapMission(rows[0]) : null;
  }
  async list(tenantId, { status, limit = 50 } = {}) {
    const params = [tenantId];
    const where = ['tenant_id=$1'];
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    params.push(limit);
    const { rows } = await this.pool.query(`SELECT * FROM victus_missions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
    return rows.map(mapMission);
  }
}

function mapMission(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    goal: row.goal,
    status: row.status,
    constraints: row.constraints || {},
    metadata: row.metadata || {},
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    cancelRequested: false,
  };
}

class MissionEngine {
  constructor({ repository = new InMemoryMissionRepository(), worldModel = null, toolBus = null, killSwitch = null, maxMissionsPerTenant = 100, maxTasksPerMission = MAX_TASKS, maxConcurrentRuns = 4 } = {}) {
    this.repository = repository;
    this.worldModel = worldModel;
    this.toolBus = toolBus;
    this.killSwitch = killSwitch;
    this.maxMissionsPerTenant = boundedInt(maxMissionsPerTenant, 100, 1, 10000);
    this.maxTasksPerMission = boundedInt(maxTasksPerMission, MAX_TASKS, 1, MAX_TASKS);
    this.maxConcurrentRuns = boundedInt(maxConcurrentRuns, 4, 1, 32);
    this.activeRuns = new Map();
  }

  async createMission(input, tenantId) {
    const mission = normalizeMission(input, tenantId);
    if (mission.tasks.length > this.maxTasksPerMission) throw new RangeError(`mission cannot contain more than ${this.maxTasksPerMission} tasks`);
    const existing = await this.repository.list(mission.tenantId, { limit: this.maxMissionsPerTenant + 1 });
    if (existing.length >= this.maxMissionsPerTenant) throw new RangeError('mission limit reached');
    await this.repository.create(mission);
    await this._syncWorldModel(mission, 'created');
    return mission;
  }

  async createMissionFromPlan({ goal, name, plan, constraints = {}, metadata = {} }, tenantId) {
    if (!plan || !Array.isArray(plan.steps)) throw new TypeError('plan.steps is required');
    const tasks = plan.steps.map(step => ({
      id: step.id,
      description: step.description || step.action,
      action: step.action,
      input: step.input || {},
      dependsOn: step.dependsOn || [],
      recoveryStrategy: step.recoveryStrategy || 'stop',
      requiresApproval: step.requiresApproval === true,
      requiresVerification: step.requiresVerification !== false,
    }));
    return this.createMission({ goal, name: name || goal, constraints, metadata, tasks }, tenantId);
  }

  async getMission(tenantId, missionId) {
    return this.repository.get(requiredString(tenantId, 'tenantId', 240), requiredString(missionId, 'missionId', 160));
  }

  async listMissions(tenantId, options = {}) {
    const limit = boundedInt(options.limit, 50, 1, 100);
    const status = options.status ? requiredString(options.status, 'status', 40).toUpperCase() : undefined;
    if (status && !MISSION_STATES.includes(status)) throw new TypeError(`unsupported mission status: ${status}`);
    return this.repository.list(requiredString(tenantId, 'tenantId', 240), { status, limit });
  }

  async _save(mission) {
    const saved = await this.repository.save(mission);
    // Keep the live task object references intact while reconciling the
    // repository's optimistic version. Replacing `mission.tasks` here would
    // invalidate the task reference currently being executed.
    if (saved && typeof saved === 'object') {
      mission.version = saved.version;
      mission.updatedAt = saved.updatedAt;
      mission.startedAt = saved.startedAt ?? mission.startedAt;
      mission.completedAt = saved.completedAt ?? mission.completedAt;
    }
    return mission;
  }

  readyTasks(mission) {
    const byId = new Map(mission.tasks.map(task => [task.id, task]));
    return mission.tasks
      .filter(task => task.status === 'PENDING')
      .filter(task => task.dependsOn.every(depId => byId.get(depId)?.status === 'SUCCEEDED'))
      .sort((a,b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
  }

  markBlockedTasks(mission) {
    const byId = new Map(mission.tasks.map(task => [task.id, task]));
    let changed = false;
    for (const task of mission.tasks) {
      if (task.status !== 'PENDING') continue;
      if (task.dependsOn.some(depId => TERMINAL_TASK_STATES.has(byId.get(depId)?.status) && byId.get(depId)?.status !== 'SUCCEEDED')) {
        task.status = 'BLOCKED';
        task.error = 'blocked by an unsuccessful dependency';
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    return changed;
  }

  async startMission(tenantId, missionId, { humanApproval = false, verifyTask, maxTaskExecutions = MAX_RUN_TASK_EXECUTIONS } = {}) {
    const mission = await this.getMission(tenantId, missionId);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL_MISSION_STATES.has(mission.status)) return mission;
    if (this.activeRuns.size >= this.maxConcurrentRuns && !this.activeRuns.has(`${tenantId}:${missionId}`)) throw new Error('mission runner capacity reached');
    this.killSwitch?.assertRunning('all');

    const key = `${tenantId}:${missionId}`;
    if (this.activeRuns.has(key)) return this.activeRuns.get(key).promise;
    const controller = new AbortController();
    const run = { controller, cancelRequested: false, pauseRequested: false, promise: null };
    this.activeRuns.set(key, run);
    run.promise = this._run(mission, { humanApproval, verifyTask, maxTaskExecutions: boundedInt(maxTaskExecutions, MAX_RUN_TASK_EXECUTIONS, 1, MAX_RUN_TASK_EXECUTIONS), signal: controller.signal, run });
    try { return await run.promise; } finally { this.activeRuns.delete(key); }
  }

  async _run(mission, { humanApproval, verifyTask, maxTaskExecutions, signal, run }) {
    mission.status = 'RUNNING';
    mission.startedAt = mission.startedAt || new Date().toISOString();
    mission.cancelRequested = false;
    await this._save(mission);
    await this._syncWorldModel(mission, 'started');

    let executions = 0;
    while (executions < maxTaskExecutions) {
      this.killSwitch?.assertRunning('all');
      if (signal.aborted || run.cancelRequested || mission.cancelRequested) {
        mission.status = 'CANCELLED';
        for (const task of mission.tasks) if (task.status === 'PENDING' || task.status === 'RUNNING') task.status = 'CANCELLED';
        mission.completedAt = new Date().toISOString();
        await this._save(mission);
        await this._syncWorldModel(mission, 'cancelled');
        return mission;
      }
      if (run.pauseRequested) {
        mission.status = 'PAUSED';
        await this._save(mission);
        await this._syncWorldModel(mission, 'paused');
        return mission;
      }

      this.markBlockedTasks(mission);
      const ready = this.readyTasks(mission);
      if (!ready.length) {
        const allDone = mission.tasks.every(task => task.status === 'SUCCEEDED');
        if (allDone) {
          mission.status = 'SUCCEEDED';
        } else if (mission.tasks.some(task => task.status === 'BLOCKED' || task.status === 'FAILED')) {
          mission.status = 'FAILED';
        } else {
          mission.status = 'PAUSED';
        }
        if (TERMINAL_MISSION_STATES.has(mission.status)) mission.completedAt = new Date().toISOString();
        await this._save(mission);
        await this._syncWorldModel(mission, mission.status.toLowerCase());
        return mission;
      }

      for (const task of ready) {
        if (executions >= maxTaskExecutions) break;
        this.killSwitch?.assertRunning('all');
        if (task.requiresApproval && humanApproval !== true) {
          mission.status = 'PAUSED';
          await this._save(mission);
          return mission;
        }
        if (!this.toolBus || typeof this.toolBus.execute !== 'function') throw new Error('mission tool bus not configured');

        executions += 1;
        task.status = 'RUNNING';
        task.attempts += 1;
        task.updatedAt = new Date().toISOString();
        await this._save(mission);
        await this._syncWorldModel(mission, `task:${task.id}:started`);

        try {
          const output = await this.toolBus.execute(task.action, task.input, {
            tenantId: mission.tenantId,
            missionId: mission.id,
            mission,
            task,
            humanApproval: humanApproval === true,
            signal,
          });
          const result = output?.result === undefined ? output : output.result;
          const encoded = JSON.stringify(result == null ? null : result);
          if (Buffer.byteLength(encoded, 'utf8') > MAX_OUTPUT_BYTES) throw new RangeError(`task result exceeds ${MAX_OUTPUT_BYTES} bytes`);

          let verification = { verified: true, confidence: 0.8, skipped: true };
          if (task.requiresVerification && typeof verifyTask === 'function') {
            verification = await verifyTask({ mission, task, result, signal });
            if (!verification || verification.verified !== true) throw new Error('task verification failed');
          }

          task.result = result;
          task.verification = verification;
          task.error = null;
          task.status = 'SUCCEEDED';
          task.updatedAt = new Date().toISOString();
          await this._save(mission);
          await this._recordTaskResult(mission, task, result, verification);
        } catch (error) {
          task.error = String(error.message || error).slice(0, 2000);
          task.verification = null;
          task.updatedAt = new Date().toISOString();
          if (signal.aborted || run.cancelRequested) {
            task.status = 'CANCELLED';
            mission.status = 'CANCELLED';
            for (const other of mission.tasks) if (other.status === 'PENDING') other.status = 'CANCELLED';
            mission.completedAt = new Date().toISOString();
            await this._save(mission);
            await this._syncWorldModel(mission, `task:${task.id}:cancelled`);
            return mission;
          }
          if (task.recoveryStrategy === 'retry' && task.attempts < task.maxAttempts) {
            task.status = 'PENDING';
          } else if (task.recoveryStrategy === 'skip') {
            task.status = 'SUCCEEDED';
            task.result = { skipped: true, error: task.error };
          } else {
            task.status = 'FAILED';
            mission.status = 'FAILED';
            mission.completedAt = new Date().toISOString();
          }
          await this._save(mission);
          await this._syncWorldModel(mission, `task:${task.id}:failed`);
          if (mission.status === 'FAILED') return mission;
        }
      }
    }

    mission.status = mission.tasks.every(task => task.status === 'SUCCEEDED') ? 'SUCCEEDED' : 'PAUSED';
    if (TERMINAL_MISSION_STATES.has(mission.status)) mission.completedAt = new Date().toISOString();
    await this._save(mission);
    await this._syncWorldModel(mission, mission.status.toLowerCase());
    return mission;
  }

  async pauseMission(tenantId, missionId) {
    const mission = await this.getMission(tenantId, missionId);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL_MISSION_STATES.has(mission.status)) return mission;
    mission.status = 'PAUSED';
    mission.updatedAt = new Date().toISOString();
    const run = this.activeRuns.get(`${tenantId}:${missionId}`);
    if (run) {
      run.pauseRequested = true;
      // The active runner owns the persisted mission object. Do not write a
      // second snapshot here or its optimistic version would conflict with
      // the runner's next task checkpoint.
      return { ...mission, status: 'PAUSED' };
    }
    await this._save(mission);
    await this._syncWorldModel(mission, 'paused');
    return mission;
  }

  async cancelMission(tenantId, missionId) {
    const mission = await this.getMission(tenantId, missionId);
    if (!mission) throw new Error('mission not found');
    if (TERMINAL_MISSION_STATES.has(mission.status)) return mission;
    mission.cancelRequested = true;
    const run = this.activeRuns.get(`${tenantId}:${missionId}`);
    if (run) {
      run.cancelRequested = true;
      run.controller.abort();
      return { ...mission, cancelRequested: true, status: 'CANCELLED' };
    }
    mission.status = 'CANCELLED';
    mission.completedAt = new Date().toISOString();
    for (const task of mission.tasks) if (task.status === 'PENDING') task.status = 'CANCELLED';
    await this._save(mission);
    await this._syncWorldModel(mission, 'cancelled');
    return mission;
  }

  async _syncWorldModel(mission, event) {
    if (!this.worldModel) return;
    try {
      const project = await this.worldModel.upsertEntity({
        id: `mission:${mission.id}`,
        type: 'PROJECT',
        name: mission.name,
        status: mission.status,
        confidence: 0.9,
        attributes: { kind: 'MISSION', goal: mission.goal.slice(0, 1000), event },
      }, mission.tenantId);
      const taskEntities = new Map();
      for (const task of mission.tasks) {
        const row = await this.worldModel.upsertEntity({
          id: `mission:${mission.id}:task:${task.id}`,
          type: 'TASK',
          name: task.description,
          status: task.status,
          confidence: task.status === 'SUCCEEDED' ? 0.9 : 0.6,
          attributes: { missionId: mission.id, action: task.action, attempts: task.attempts, requiresApproval: task.requiresApproval },
        }, mission.tenantId);
        taskEntities.set(task.id, row);
        await this.worldModel.link({ fromId: project.id, toId: row.id, relation: 'CONTAINS' }, mission.tenantId);
      }
      for (const task of mission.tasks) {
        for (const dependency of task.dependsOn) {
          const from = taskEntities.get(dependency);
          const to = taskEntities.get(task.id);
          if (from && to) await this.worldModel.link({ fromId: from.id, toId: to.id, relation: 'DEPENDS_ON' }, mission.tenantId);
        }
      }
    } catch {
      // World Model is descriptive context, never a mission execution dependency.
    }
  }

  async _recordTaskResult(mission, task, result, verification) {
    if (!this.worldModel) return;
    try {
      const resultEntity = await this.worldModel.upsertEntity({
        id: `mission:${mission.id}:task:${task.id}:result`,
        type: 'RESULT',
        name: `Result: ${task.description}`.slice(0, 240),
        status: 'VERIFIED',
        confidence: Number.isFinite(verification?.confidence) ? Math.max(0, Math.min(1, verification.confidence)) : 0.8,
        attributes: { missionId: mission.id, taskId: task.id, result: typeof result === 'object' ? result : { value: String(result ?? '').slice(0, 1000) } },
      }, mission.tenantId);
      await this.worldModel.link({ fromId: `mission:${mission.id}:task:${task.id}`, toId: resultEntity.id, relation: 'PRODUCES' }, mission.tenantId);
    } catch {
      // Non-critical observability/state enrichment.
    }
  }
}

function createMissionEngine({ db, ...options } = {}) {
  const repository = db?.getPool?.() ? new PostgresMissionRepository(db.getPool()) : new InMemoryMissionRepository();
  return new MissionEngine({ ...options, repository });
}

module.exports = {
  MISSION_STATES,
  TASK_STATES,
  TERMINAL_MISSION_STATES,
  normalizeTask,
  normalizeMission,
  detectCycles,
  InMemoryMissionRepository,
  PostgresMissionRepository,
  MissionEngine,
  createMissionEngine,
};
