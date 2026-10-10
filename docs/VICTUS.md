# Victus Architecture

Victus is implemented here as an intelligence layer rather than a model. The existing language providers are optional perception/synthesis components; the system of record for knowledge, plans, tool permissions, verification state, experiments, and evolution decisions lives outside the model.

## Architecture

```text
                         ┌────────────────────────────┐
                         │  Semantic Interface         │
                         │  text → intent/constraints  │
                         └─────────────┬──────────────┘
                                       │
                               Goal / Evidence Need
                                       │
                         ┌─────────────▼──────────────┐
                         │  Victus Reasoning Core      │
                         │  plan + retrieve + decide   │
                         └──────┬──────┬──────┬────────┘
                                │      │      │
                ┌───────────────┘      │      └───────────────┐
                ▼                      ▼                      ▼
        ┌──────────────┐      ┌────────────────┐      ┌───────────────┐
        │ Memory       │      │ Knowledge Graph │      │ Tool Bus       │
        │ W/E/S/P/U    │      │ claims+provenance│      │ contracts+ACLs │
        └──────┬───────┘      └────────┬───────┘      └───────┬───────┘
               │                       │                      │
               └──────────────┬────────┴───────────────┬──────┘
                              ▼                        ▼
                       ┌──────────────┐        ┌──────────────┐
                       │ Verification │        │ Sandbox/Exec │
                       │ evidence/conf│        │ isolated work │
                       └──────┬───────┘        └──────┬───────┘
                              │                        │
                              └──────────┬─────────────┘
                                         ▼
                                 ┌───────────────┐
                                 │ Evolution     │
                                 │ test→bench→   │
                                 │ canary→accept │
                                 └──────┬────────┘
                                        ▼
                                 Stable version
```

## Implemented core in this increment

- Structured claims with provenance and contradiction preservation.
- Multi-source verification and confidence scoring.
- Executable DAG planning primitives with explicit failure/recovery fields.
- Capability-oriented Tool Bus with policy checks before execution.
- Tenant-isolated USER memory plus shared/global tiers.
- Immutable-security-path enforcement for evolution proposals.
- Evolution registry with immutable version records and an acceptance gate.
- Evolution controller that rejects unproven candidates and supports canary/rollback adapters.

## Why this is not a clone

There is no single conversational model at the center. Providers can be swapped or removed. The durable intelligence state is represented as claims, memory objects, plans, tool contracts, experiment records, and evolution records.

## Current honest boundary

Natural-language understanding is still best handled by an existing language model or deterministic parser. General-purpose semantic parsing from arbitrary human language into perfect formal logic remains an open engineering/research problem. Victus therefore treats language parsing as a replaceable adapter and keeps the control plane model-independent.


## Upgraded execution loop

Victus now has a unified `runGoal()` path that can retrieve relevant memory, choose a historically successful workflow, execute a DAG plan through the Tool Bus, verify the result, record telemetry, and update experience data. This turns the previously separate primitives into one reusable control loop.

## Coding intelligence upgrade

The Developer Hub now adds deterministic source preflight (language detection, complexity signals, symbol extraction, and security-sensitive pattern detection) before model reasoning. Deep coding requests can run a plan pass, implementation pass, verification pass, and revision pass when verification starts with `REVISE`. New workflows include architecture, optimization, security review, and migration planning. User code is analyzed as text and is not executed by the coding agent.


## Self-monitoring and bounded autonomous reasoning

Victus now has an operational self-monitor (`src/victus/core/selfMonitor.js`) that tracks task state, checkpoints, confidence, anomalies, tool counts, recovery budgets, and final outcomes. A bounded autonomous reasoner can choose `CONTINUE`, `VERIFY_AGAIN`, `RETRY`, `REPLAN`, `ESCALATE`, or `STOP` from observed execution state. `VictusEngine.runGoal()` can use those decisions to perform one or more bounded verification/replan cycles through explicit callbacks.

This is introspection over software state and execution outcomes. It is not a claim of consciousness or subjective experience.

The live operational status is exposed at `GET /api/victus/self-monitor` and does not return prompts, API keys, or fetched page contents.


## Victus Language Model

Victus now has a dedicated model layer under `models/victus-lm/`. The model is intentionally separate from the control plane: the language model generates text/code, while Victus continues to own permissions, planning, research, verification, self-monitoring, and safety locks.

The first trainable baseline uses `Qwen/Qwen3-0.6B` as a configurable starting checkpoint. This is a fine-tunable starting point, not a claim that the repository already contains frontier-level trained Victus weights.

The model stack provides:
- curated conversational JSONL training data
- supervised fine-tuning with TRL
- optional LoRA adapters with PEFT
- deterministic smoke evaluation
- an OpenAI-compatible local server

Nova can route to a served Victus model with `VICTUS_MODEL_URL`, `VICTUS_MODEL_NAME`, and optional `VICTUS_MODEL_KEY`.

The model cannot change its own software, permissions, safety rules, or training data.
