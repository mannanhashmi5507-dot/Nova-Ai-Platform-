# Changelog

## v14-audit — full system audit of v14

- Fixed: `GET` safety control-plane routes (`/api/victus/safety/status`, `/audit`, `/audit/verify`, `/proposals*`) were shadowed by the catch-all route; catch-all moved to the end of `src/index.js`.
- Fixed: `InternetGateway.status()` threw a ReferenceError (startup log and `/api/victus/internet/status`).
- Added: `test/victusAuditSecurity.test.js` (18 passing boundary tests, 12 `todo` tests for confirmed gaps F-01…F-12).
- Added: `docs/AUDIT_V14.md` (findings, readiness, provider independence, architecture).
- No safety restriction was changed. All other findings are reported, not fixed.


## Victus Internet Layer

- Added provider-independent, read-only Victus Internet Gateway with local and remote relay nodes.
- Added latency/success/load-aware routing, automatic failover, circuit breaking, bounded caching, and stale-on-error fallback.
- Added SSRF-safe URL validation and per-request domain narrowing, with explicit allowlist or public-internet configuration.
- Added dedicated `internet` kill-switch scope and admin node management.
- Added standalone `victus:internet-node` relay launcher and documentation.
- Added 8 focused Internet Layer tests.

# Changelog

## v11 — review & hardening pass on v10 (UACL + Victus)

Full detail, with severity, file and root cause for every item, is in `docs/REVIEW_V10.md`.

### Security
- UACL admin endpoints no longer open when `UACL_ADMIN_KEY` is unset; admin/worker endpoints fail closed (503). Secrets compared in constant time.
- UACL jobs are scoped to the authenticated user (previously the request body chose the tenant; cancel skipped the ownership check; job lookup was unauthenticated).
- Per-worker credentials replace the single shared key as a worker identity; a live worker id cannot be hijacked by re-registering.
- Locked control plane now covers the real files (`src/victus`, `src/middleware`, `src/index.js`, `src/db`, `models`, deployment/dependency files). Paths are normalised (traversal, case, encoding, separators, absolute paths) and paths named inside a diff are checked, so a proposal cannot under-declare what it touches.
- Tool bus: high-risk (`DEPLOY`/`DELETE`/`ADMIN`) tools require explicit human approval; declared `maxOutputBytes` is now enforced.
- Research fetcher: decompression-bomb cap, correct handling of already-decoded gzip/br/deflate bodies (real sites previously failed), callers can only narrow the server allowlist, connection pinned to the validated DNS answer (DNS-rebinding), hidden-element stripping, hardened and de-false-positived injection filter.
- Victus model provider: URL validation, refuses to send the API key over plain http to remote hosts, validates response shape, no upstream body echoed in errors.
- Memory store: a caller-chosen id can no longer overwrite another tenant's memory.

### UACL correctness
- Queue no longer becomes permanently full after N lifetime jobs; finished jobs are retained boundedly.
- Jobs on a lost worker are re-queued (bounded attempts) instead of stuck until expiry; late results from a lost worker are refused.
- Per-worker concurrency limit; tenant limit counts queued jobs; runtime limit for running jobs; explicit state machine; idempotency keys; input/result size and depth limits; capability/price clamping; workerId validation.
- Cancel is delivered to the worker (via heartbeat) and aborts the running handler.
- Background sweeper; graceful server and worker shutdown; invalid `UACL_MAX_QUEUE` no longer means "unlimited".
- Kill switch: one route table (the divergent `mountUaclRoutes` that left heartbeat unauthenticated is now the only, correct mount); the scheduler itself refuses to start new work while stopped.

### Victus
- Engine: retrieval failures no longer leak monitor sessions; replan/verify cycles hard-capped; listener exceptions can't break a goal; unverified (fast-mode) runs are no longer credited as successes; coding learning key uses the detected language.
- Bounded memory for telemetry, experience, memory, knowledge graph and self-monitor sessions; knowledge graph no longer returns superseded claims.
- Kill switch status reports when persistence failed.

### Tests
- +51 regression tests (`victusUaclHardening`, `victusResearchHardening`, `victusReviewFixes`), plus updates to one fixture.

## v12 — Victus World Model

### New technology
- Added a typed, tenant-scoped Victus World Model for `USER`, `PROJECT`, `TASK`, `KNOWLEDGE`, `RESOURCE`, `TOOL`, `DEPENDENCY`, `EVENT`, and `RESULT` entities.
- Added explicit graph relationships including ownership, containment, dependencies, tool/resource usage, provenance-like derivation, and task/result links.
- Added bounded graph traversal, context extraction and snapshots.
- Added optional Postgres persistence with composite tenant/entity keys and foreign-key protected edges.
- Added authenticated `/api/victus/world/*` APIs with tenant scoping and request limits.
- Added sensitive-attribute filtering and bounded entity/edge counts to reduce accidental secret storage and memory exhaustion.
- Integrated Victus goal execution with descriptive TASK/RESULT state; World Model failures are non-fatal to execution.

### Safety boundary
- World Model records state only. It is not an authorization source and cannot grant tool permissions, alter safety policy, or execute actions.

## v13 — Victus Mission Engine
- Added a bounded, tenant-scoped Mission Engine for structured goal execution.
- Added dependency validation and cycle detection.
- Added mission/task lifecycle, retries, skip/stop recovery, verification gates, pause/cancel behavior, and explicit human approval handling.
- Added kill-switch checks around mission execution.
- Added Postgres persistence table for missions and in-memory fallback.
- Added mission API routes.
- Added World Model integration for mission/project, task, dependency, and result state.
- Added dependency-free regression tests covering DAG execution, retries, approval, kill switch, cancellation, tenant isolation, and World Model integration.
