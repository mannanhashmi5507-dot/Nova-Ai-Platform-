# Victus Build Plan: MVP → Production

## Phase 1 — Memory + Knowledge Graph (implemented in this increment)

Architecture: typed memory tiers, durable claim objects, provenance, contradiction preservation.

APIs: `MemoryStore.put/search/delete`, `KnowledgeGraph.addClaim/find/get`, `makeClaim`.

Database: `victus_memory_items`, `victus_knowledge_claims`.

Security: USER memory requires a tenant ID and search/delete enforce tenant isolation.

Benchmark target: retrieval latency, memory precision@k, contradiction retention rate.

## Phase 2 — Internet Retrieval + Provenance (implemented in this increment)

Architecture: query planning → source discovery → fetch → extraction → claim creation.

APIs: `ResearchPipeline.research(goal, options)`.

Security: fetch/extraction are adapter boundaries; caller owns network allowlists and credentials.

Failure cases: duplicate sources, fetch errors, malformed source types, low-confidence evidence.

## Phase 3 — Verification + Confidence (implemented in this increment)

Architecture: source corroboration + independence + freshness + reliability - contradiction penalties.

API: `verifyClaims(claims, options)`.

Important: this is a deterministic scoring function, not a proof of truth. Confidence is evidence confidence, not epistemic certainty.

## Phase 4 — Planning + Tool Bus (core primitives implemented)

Architecture: executable DAG plans with preconditions, expected results, postconditions, failure conditions and recovery strategies. Tool definitions specify permissions, risk, timeouts and resource limits.

APIs: `PlanGraph`, `ToolBus.execute`.

## Phase 5 — Sandboxed Code Execution (next)

Add isolated worker execution with filesystem/network/resource capability controls, signed artifacts, disposable workspaces, and deterministic test manifests. The existing Terminal Assistant deliberately does not execute commands remotely; this phase introduces execution as a separate service with a stronger trust boundary.

## Phase 6 — Autonomous Software Engineering (next)

Repository inspection → reproduce → patch → static analysis → tests → benchmark → staging. Changes are represented as evolution records and cannot modify immutable security paths without human approval.

## Phase 7 — Experimentation + Benchmarking (core registry implemented)

Every candidate becomes an experiment with a hypothesis, baseline, candidate, metrics, dataset, resource budget, result, and decision.

## Phase 8 — Canary Deployment + Rollback (controller hooks implemented)

The evolution controller supports canary and rollback adapters, but the production deployment adapter is intentionally not wired to a real cloud provider yet.

## Phase 9 — Experience Learning (core implemented)

Implemented: `ExperienceStore` (recency-weighted, Beta-smoothed success per task family, small exploration bonus) and `VictusEngine.chooseWorkflow`. `executePlan` records outcomes when `context.workflow` is set. Memory search now uses BM25 ranking (`BM25Index`) instead of token-hit counting.

Add procedural memory from successful plans, outcome-weighted workflow selection, source-ranking feedback, and task-family benchmarks. Learning remains primarily in memory/algorithms rather than model retraining.

## Phase 10 — Distributed Victus

Split research workers, execution sandboxes, graph storage, telemetry, evolution workers and policy services. Use immutable signed releases for the control plane and isolated capability tokens for the execution plane.

## Known Research Boundary

Victus still needs a language interface for arbitrary natural-language requests. Replacing that interface with a perfect parser for unrestricted human language is not solved by this codebase. The architecture therefore treats language understanding as a replaceable component and keeps planning, evidence, memory, policy and evolution outside it.

## v13 — Victus Mission Engine

Adds the bounded mission orchestration layer between Victus planning, the World Model, and the ToolBus.

- Converts structured `PlanGraph` plans into tenant-scoped missions.
- Validates dependencies and rejects cycles.
- Executes only registered ToolBus actions.
- Supports retries, verification gates, pause/cancel, bounded execution, and explicit human approval.
- Checks the existing Victus kill switch before execution and before each task.
- Persists missions in Postgres with optimistic version checks and uses a bounded in-memory fallback.
- Mirrors mission/project, task, dependency, and result state into the World Model.

## v14 — Victus Internet Layer

Adds the provider-independent internet access plane for live web reads.

- Routes through local egress or interchangeable remote relay nodes.
- Scores nodes using success rate, latency, load, weight, and optional preferred region.
- Automatically fails over and uses a circuit breaker for unhealthy nodes.
- Caches bounded read results and serves stale data during outages.
- Reuses Victus SSRF, DNS-pinning, redirect, response-size, and prompt-injection protections.
- Adds a dedicated `internet` kill-switch scope.
- Keeps the design read-only: no arbitrary web writes or command execution.
