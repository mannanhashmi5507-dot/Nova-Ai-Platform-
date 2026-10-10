'use strict';

const { PlanGraph } = require('./planner');
const { verifyClaims } = require('./verification');
const { Telemetry } = require('./telemetry');
const { ExperienceStore } = require('./experience');
const { VictusSelfMonitor, AutonomousReasoner } = require('./selfMonitor');

class VictusEngine {
  constructor({ research, toolBus, knowledgeGraph, memory, telemetry, experience, selfMonitor, reasoner, worldModel } = {}) {
    this.research = research || null;
    this.toolBus = toolBus || null;
    this.knowledgeGraph = knowledgeGraph || null;
    this.memory = memory || null;
    this.telemetry = telemetry || new Telemetry();
    this.experience = experience || new ExperienceStore();
    this.selfMonitor = selfMonitor || new VictusSelfMonitor({ reasoner: reasoner || new AutonomousReasoner() });
    this.worldModel = worldModel || null;
  }

  // Pick the historically best workflow for this kind of goal.
  chooseWorkflow(goal, workflows) { return this.experience.best(goal, workflows); }

  async runGoal({
    goal,
    workflows = [],
    workflow,
    plan,
    context = {},
    retrieve,
    verify,
    verifyAgain,
    replan,
    onEvent = () => {},
    maxAutonomousCycles = 2,
  } = {}) {
    maxAutonomousCycles = Math.max(0, Math.min(5, Math.floor(Number(maxAutonomousCycles)) || 0)); // hard ceiling on replan/verify loops
    if (!goal || typeof goal !== 'string') throw new TypeError('goal is required');
    if (!this.toolBus && plan) throw new Error('tool bus is required for plan execution');

    const started = Date.now();
    const chosen = workflow || (workflows.length ? this.chooseWorkflow(goal, workflows).workflow : null);
    const taskId = context.taskId || undefined;
    const monitor = this.selfMonitor.begin({ taskId, goal, workflow: chosen });

    // The World Model is descriptive context, never an authorization source.
    // A world-model failure must never break the actual goal execution path.
    let worldTask = null;
    if (this.worldModel && context.tenantId) {
      try {
        worldTask = await this.worldModel.upsertEntity({
          id: monitor.taskId,
          type: 'TASK',
          name: goal.slice(0, 240),
          status: 'RUNNING',
          confidence: 0.5,
          attributes: { workflow: chosen || null },
        }, context.tenantId);
      } catch {
        worldTask = null;
      }
    }
    const rawOnEvent = onEvent;
    onEvent = event => { try { rawOnEvent(event); } catch { /* a faulty listener must not break the goal */ } };
    const trace = [{ stage: 'goal', goal, workflow: chosen }];
    onEvent({ type: 'goal.start', goal, workflow: chosen, taskId: monitor.taskId });

    let memories = [];
    let currentPlan = plan;
    let results = [];
    let verification = null;
    let autonomousCycles = 0;
    let finalDecision = { action: 'CONTINUE', reason: 'not yet evaluated', confidence: 0.5 };

    try {
      // Retrieval is inside the guarded block: if it throws, the monitor session is closed and failure is recorded.
      if (typeof retrieve === 'function') {
        memories = await retrieve(goal, context);
        if (!Array.isArray(memories)) memories = [];
        trace.push({ stage: 'memory', count: memories.length });
      } else if (this.memory?.search) {
        memories = this.memory.search({ query: goal, tenantId: context.tenantId, limit: 8 });
        trace.push({ stage: 'memory', count: memories.length });
      }
      this.selfMonitor.checkpoint(monitor.taskId, 'MEMORY', { sourceCount: memories.length });

      while (true) {
        results = [];
        if (currentPlan) {
          try {
            results = await this.executePlan(currentPlan, {
              ...context,
              workflow: chosen,
              memories,
              recordExperience: false,
            });
            trace.push({ stage: 'execution', steps: results.length, cycle: autonomousCycles });
            this.selfMonitor.checkpoint(monitor.taskId, 'EXECUTION', {
              stepCount: results.length,
              failedStepCount: 0,
              toolCalls: results.length,
            });
            onEvent({ type: 'goal.execution', steps: results.length, cycle: autonomousCycles });
          } catch (error) {
            this.selfMonitor.signal(monitor.taskId, {
              name: 'execution_failure',
              severity: 'HIGH',
              detail: error.message,
            });
            finalDecision = this.selfMonitor.decide(monitor.taskId, { error });
            trace.push({ stage: 'autonomous-decision', decision: finalDecision });
            if (finalDecision.action === 'REPLAN' && typeof replan === 'function' && autonomousCycles < maxAutonomousCycles) {
              autonomousCycles += 1;
              currentPlan = await replan({ goal, workflow: chosen, memories, results, error, cycle: autonomousCycles });
              trace.push({ stage: 'replan', cycle: autonomousCycles });
              continue;
            }
            throw error;
          }
        }

        if (typeof verify === 'function') {
          verification = await verify({ goal, workflow: chosen, memories, results, context, cycle: autonomousCycles });
          trace.push({ stage: 'verification', verification, cycle: autonomousCycles });
          const confidence = Number.isFinite(verification?.confidence) ? verification.confidence : 0.5;
          this.selfMonitor.checkpoint(monitor.taskId, 'VERIFICATION', { confidence });
          if (verification?.verified === false) {
            finalDecision = this.selfMonitor.decide(monitor.taskId, { verification });
            trace.push({ stage: 'autonomous-decision', decision: finalDecision });

            if (finalDecision.action === 'VERIFY_AGAIN' && typeof verifyAgain === 'function' && autonomousCycles < maxAutonomousCycles) {
              autonomousCycles += 1;
              verification = await verifyAgain({ goal, workflow: chosen, memories, results, context, previous: verification, cycle: autonomousCycles });
              trace.push({ stage: 'verification-repeat', verification, cycle: autonomousCycles });
              this.selfMonitor.checkpoint(monitor.taskId, 'VERIFICATION', {
                confidence: Number.isFinite(verification?.confidence) ? verification.confidence : 0.5,
              });
            }

            if (verification?.verified === false && finalDecision.action !== 'REPLAN' && finalDecision.action !== 'VERIFY_AGAIN') {
              finalDecision = this.selfMonitor.decide(monitor.taskId, { verification });
            }

            if (finalDecision.action === 'REPLAN' && typeof replan === 'function' && autonomousCycles < maxAutonomousCycles) {
              autonomousCycles += 1;
              currentPlan = await replan({ goal, workflow: chosen, memories, results, verification, cycle: autonomousCycles });
              trace.push({ stage: 'replan', cycle: autonomousCycles });
              continue;
            }
          } else {
            finalDecision = this.selfMonitor.decide(monitor.taskId, { verification });
            trace.push({ stage: 'autonomous-decision', decision: finalDecision });
          }
        } else if (Array.isArray(context.claims)) {
          verification = verifyClaims(context.claims, context.verification);
          trace.push({ stage: 'verification', verification });
          this.selfMonitor.checkpoint(monitor.taskId, 'VERIFICATION', { confidence: verification.confidence, sourceCount: verification.sourceCount });
          finalDecision = this.selfMonitor.decide(monitor.taskId, { verification });
          trace.push({ stage: 'autonomous-decision', decision: finalDecision });
        } else {
          finalDecision = this.selfMonitor.decide(monitor.taskId, {});
          trace.push({ stage: 'autonomous-decision', decision: finalDecision });
        }

        break;
      }
    } catch (error) {
      const durationMs = Date.now() - started;
      const monitorResult = this.selfMonitor.complete(monitor.taskId, {
        success: false,
        confidence: 0,
        reason: error.message,
      });
      if (chosen) this.experience.record({ goal, family: context.experienceFamily, workflow: chosen, success: false, durationMs, cost: context.cost || 0 });
      this.telemetry.record({ type: 'goal', taskId: monitor.taskId, durationMs, success: false, quality: 0, cost: context.cost || 0, metadata: { goal, workflow: chosen, steps: results.length, error: error.message, decision: finalDecision.action } });
      onEvent({ type: 'goal.complete', taskId: monitor.taskId, success: false, error: error.message, selfMonitor: monitorResult });
      if (this.worldModel && context.tenantId && worldTask) {
        try {
          await this.worldModel.upsertEntity({ id: worldTask.id, type: 'TASK', name: worldTask.name, status: 'FAILED', confidence: 0, attributes: { workflow: chosen || null, error: error.message.slice(0, 1000) } }, context.tenantId);
        } catch { /* world model is non-critical to task execution */ }
      }
      throw error;
    }

    const success = verification == null
      ? finalDecision.action !== 'STOP' && finalDecision.action !== 'ESCALATE'
      : verification.verified !== false && (verification.confidence == null || verification.confidence >= 0.55);
    const confidence = verification?.confidence ?? (success ? 0.8 : 0.3);
    const monitorResult = this.selfMonitor.complete(monitor.taskId, {
      success,
      confidence,
      reason: success ? 'final result passed autonomous checks' : finalDecision.reason,
      outputSize: results.reduce((sum, row) => sum + (row?.output == null ? 0 : JSON.stringify(row.output).length), 0),
    });
    // verification.learn === false means "outcome unknown" (nothing checked it): don't credit it as a success.
    if (chosen && verification?.learn !== false) this.experience.record({ goal, family: context.experienceFamily, workflow: chosen, success, durationMs: Date.now() - started, cost: context.cost || 0 });
    this.telemetry.record({ type: 'goal', taskId: monitor.taskId, durationMs: Date.now() - started, success, quality: confidence, cost: context.cost || 0, metadata: { goal, workflow: chosen, steps: results.length, autonomousCycles, decision: finalDecision.action } });
    onEvent({ type: 'goal.complete', taskId: monitor.taskId, success, selfMonitor: monitorResult });

    if (this.worldModel && context.tenantId && worldTask) {
      try {
        const resultEntity = await this.worldModel.upsertEntity({
          id: `${monitor.taskId}:result`,
          type: 'RESULT',
          name: `${success ? 'Success' : 'Failure'}: ${goal}`.slice(0, 240),
          status: success ? 'VERIFIED' : 'UNVERIFIED_OR_FAILED',
          confidence,
          attributes: { taskId: monitor.taskId, workflow: chosen || null, verification: verification || null },
        }, context.tenantId);
        await this.worldModel.link({ fromId: worldTask.id, toId: resultEntity.id, relation: 'PRODUCES' }, context.tenantId);
        await this.worldModel.upsertEntity({ id: worldTask.id, type: 'TASK', name: worldTask.name, status: success ? 'COMPLETED' : 'FAILED', confidence, attributes: { workflow: chosen || null } }, context.tenantId);
      } catch {
        // Observability/state enrichment must never turn a completed goal into a failed goal.
      }
    }

    return {
      goal,
      taskId: monitor.taskId,
      workflow: chosen,
      memories,
      results,
      verification,
      success,
      trace,
      autonomous: {
        cycles: autonomousCycles,
        decision: finalDecision,
        selfMonitor: monitorResult,
      },
    };
  }

  async researchGoal(goal, options = {}) {
    if (!this.research) throw new Error('research pipeline not configured');
    const started = Date.now();
    try {
      const result = await this.research.research(goal, options);
      for (const claim of result.claims) this.knowledgeGraph?.addClaim(claim);
      const verification = verifyClaims(result.claims, options.verification);
      this.telemetry.record({ type: 'research', durationMs: Date.now() - started, success: true, quality: verification.confidence, metadata: { goal, sourceCount: verification.sourceCount } });
      return { ...result, verification };
    } catch (error) {
      this.telemetry.record({ type: 'research', durationMs: Date.now() - started, success: false, metadata: { goal, error: error.message } });
      throw error;
    }
  }

  async executePlan(plan, context = {}) {
    const started = Date.now();
    try {
      const results = await this._runPlan(plan, context);
      if (context.workflow && context.recordExperience !== false) this.experience.record({ goal: plan.goal, workflow: context.workflow, success: true, durationMs: Date.now() - started });
      return results;
    } catch (error) {
      if (context.workflow && context.recordExperience !== false) this.experience.record({ goal: plan.goal, workflow: context.workflow, success: false, durationMs: Date.now() - started });
      throw error;
    }
  }

  async _runPlan(plan, context) {
    const results = [];
    while (!plan.isComplete()) {
      const ready = plan.readySteps();
      if (ready.length === 0) throw new Error(plan.hasFailure() ? 'plan cannot progress after failure' : 'plan has no executable ready steps');
      for (const step of ready) {
        step.attempts += 1;
        try {
          const output = await this.toolBus.execute(step.action, step.input || {}, context);
          plan.mark(step.id, 'SUCCEEDED', { output });
          results.push({ stepId: step.id, output });
        } catch (error) {
          plan.mark(step.id, 'FAILED', { error: error.message });
          if (step.recoveryStrategy === 'retry' && step.attempts < 3) {
            plan.mark(step.id, 'PENDING');
            continue;
          }
          if (step.recoveryStrategy === 'skip') {
            plan.mark(step.id, 'SUCCEEDED', { skipped: true, error: error.message });
            continue;
          }
          throw error;
        }
      }
    }
    return results;
  }
}

module.exports = { VictusEngine };
