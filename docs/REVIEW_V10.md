# Review of Nova AI + Victus Cloud (UACL) v10

Scope actually reviewed in depth: `src/victus/**` (core engine, safety, research, cloud/UACL, model provider), `scripts/uacl-worker.js`, the Victus/UACL/coding wiring in `src/index.js`, provider fallback, and the dynamic-SQL sites in `src/db/index.js` (by inspection). **Not** reviewed in depth: the frontend (`public/index.html`), billing/Stripe, teams, enterprise/SSO, social, creator, finance, productivity, documents, migrations/indexes/transactions. Treat those as unreviewed.

## A. Issues found and fixed

### CRITICAL
| # | File | Problem → root cause → fix |
|---|---|---|
| 1 | `cloud/routes.js` | Admin endpoints (`/events`) open to everyone when `UACL_ADMIN_KEY` unset (`if (!adminSecret) return next()`). → fail closed (503); explicit dev opt-in only outside production. |
| 2 | `cloud/routes.js`, `uacl.js` | Job IDOR/tenant spoofing: tenant taken from request body (bypasses per-tenant limit by choosing a new tenant), `cancel` skipped ownership when `tenantId` omitted, `GET /jobs/:id` unauthenticated. → tenant derived from the logged-in user; same 404 for missing and foreign jobs. |
| 3 | `uacl.js` | One shared secret = identity of every worker (claim/complete/fail as any worker); `registerWorker` unauthenticated and silently overwrote a live worker. → enrollment key only registers; per-worker random credential (hash stored) required for all worker actions; live ids can't be hijacked. |
| 4 | `uacl.js` | Queue permanently full after `maxQueueSize` lifetime jobs (finished jobs never deleted, limit counted all jobs) — remote DoS. → active-job limit + bounded retention/GC. |
| 5 | `cloud/routes.js` | Two divergent route tables; the unused `mountUaclRoutes` left heartbeat unauthenticated (`r.worker.heartbeat` never existed) and omitted the kill switch on paths. Core had no kill-switch awareness. → single mount; core `isHalted` gates submit/claim/register/assignment. |
| 6 | `core/policy.js`, `safety/proposalQueue.js` | "Locked core" listed `security/*` folders that don't exist; real control files (`src/victus/**`, `src/index.js`, middleware, db, deploy files) were not protected, and `startsWith` was bypassable (`src/../`, case, `%2e`, `\`, absolute paths); diff paths ignored. → real paths, canonical normalisation, segment matching, diff parsing, fail-closed on unparseable. |
| 7 | `research/safeResearchFetcher.js` | (a) gzip bomb: size checked before inflating (150 KB → 314 MB RAM); (b) HTTP clients pre-decode bodies but leave `Content-Encoding`, so gzip/br/deflate pages **failed** (research broken on most real sites); (c) `options.allowedDomains` replaced the server allowlist inside the fetcher; (d) DNS rebinding between check and connect; (e) hidden-text injection; (f) injection filter bypassed by rewording/leet/zero-width/other languages. → bounded decode by magic bytes, narrow-only allowlist, pinned agent, hidden-element stripper (linear time), normalised multi-pattern filter with false-positive tests. |

### HIGH
- Worker crash/disappearance left jobs `running` on a dead worker until expiry; healthy workers idle. → re-queue with `attempts`/`maxAttempts`, stale results refused.
- No concurrency cap: one worker was assigned every queued job. → `maxConcurrentJobs`.
- Tenant limit counted only assigned jobs, so one tenant could fill the whole queue. → counts queued.
- Running jobs expired by the *queue* TTL (long jobs killed mid-run). → separate `maxRuntimeMs`.
- No background sweep (stale workers only handled when someone called `/status`). → unref'd interval + graceful stop.
- Worker agent: overlapping polls over-claimed; never re-registered after broker restart; a failed *report* became a job failure; cancel never reached the handler; no timeout; credentials over plain http. → rewritten (with regression tests).
- Memory store let one tenant overwrite another's memory by choosing the id.
- `UACL_MAX_QUEUE=abc` evaluated to `NaN` → unlimited queue.
- Non-constant-time secret comparisons.

### MEDIUM
- Capabilities/price/priority/metadata/spec/result unbounded; `__proto__`/`constructor` keys accepted; `workerId` unvalidated; `listEvents('abc')` returned the whole log.
- Engine: retrieval failure leaked a self-monitor session and recorded nothing; `maxAutonomousCycles` unbounded; listener exceptions aborted goals; fast mode (no verifier) always credited as success (learning bias); coding experience key used raw/absent language.
- Unbounded growth: telemetry, experience, memory store, knowledge graph, self-monitor sessions. Knowledge graph returned superseded claims.
- Tool bus: `maxOutputBytes` declared, never enforced; high-risk tools ungated.
- Model provider: no URL validation, key over http, non-string content crashed `.trim()`, upstream error body echoed, `RateLimitError` never matched by `instanceof`, 60 s timeout, ignored already-aborted signals.
- No graceful server shutdown (sweeper/queues not stopped).

### LOW
- Kill switch silently ignored persistence failures (now reported in `status()`).

## B. Tests added (+51 → 485 total)
`test/victusUaclHardening.test.js` (30): duplicate claims, concurrency cap, crash after claim, retry limit, reconnect, heartbeat duplicates, cancel during execution, illegal transitions, runtime limit, queue recycling, tenant fairness, 5 000-job scale, no/incompatible workers, idempotency, hostile registration/job/result input, per-worker auth, hijack protection, kill switch (core + every HTTP route + scopes + repeat + restart), fail-closed auth, IDOR, status codes/no leaks, worker-agent races/re-register/cancel/https, end-to-end with simulated API restart.
`test/victusResearchHardening.test.js` (9) · `test/victusReviewFixes.test.js` (12): locked-path bypasses, diff smuggling, tool bus, engine loops/leaks, REVISE→PASS success logic, bounded stores, cross-tenant memory, model provider.

## C. Results (this environment)
- `node --test`: **485 tests, 476 pass, 9 fail, 0 skipped.** The 9 failing files are the same 9 that fail on the untouched v10 upload: `Cannot find module 'pg'` (dependencies are not installed in the review sandbox and there is no network). Run with a stub `pg`, those 9 files pass (63/63). With `npm install` they should pass; this was not verified against a real PostgreSQL.
- Build / lint / type-check: **not applicable — the repo defines none** (plain CommonJS, no linter, no TypeScript). `node --check src/index.js` passes.
- **Server startup and real HTTP integration were not run** (express and other dependencies not installed). Route behaviour is tested by calling the handlers and the real `mountUaclRoutes` with a fake app.
- Security tests: covered by the suites above; no external scanner or fuzzer was run.

## D. Remaining issues / not verified
- UACL state is in memory (lost on restart) and single-instance by design.
- Worker-reported capabilities and prices are clamped but trusted. A malicious *enrolled* worker can still read the specs of jobs it is given and return false results.
- Prompt-injection filtering is heuristic; the real defences are "page text is untrusted data" and that the research path has no tools to act with.
- Research search queries go to DuckDuckGo (privacy), and DNS pinning only applies to clients that honour an `agent` option (node-fetch does; Node's global fetch does not).
- While the compute kill switch is on, workers cannot re-register (registration is treated as starting compute).
- Provider fallback: a non-429 failure of the first provider is retried on every request (no short failure cool-down); the Victus provider timeout was reduced to 25 s to limit the cost.
- ToolBus default policy is allow-for-registered-tools; safety relies on only trusted code registering tools (today: one non-executing coding tool).
- Database layer: only dynamic-SQL fragments were inspected (they use fixed clauses with `$n` parameters); indexes, transactions, migrations and connection handling were not reviewed.
- Unreviewed areas listed at the top.

## E. Architecture findings
Request → Nova API → Victus engine → memory → plan → tool bus → model → verification → response → experience/telemetry matches the intended design for the coding path. The research and UACL paths are separate and are not yet called by the engine (research is an API; UACL is a broker with no provider adapter). Victus has no code path that edits its own source, policy, allowlist, kill switch or audit log: proposals are queued data and only a human can approve; `evolution/` is not reachable from any route.

## F. Security status
Attack surface: public chat/agent endpoints, authenticated UACL client endpoints, key-protected admin/enrollment endpoints, per-worker-credential endpoints, the allowlisted research fetcher. No command execution, `eval`, child processes or filesystem writes exist outside the safety audit/state files. Main residual risks: a compromised enrolled worker, a compromised allowlisted website, leaked admin/enrollment keys, and anything in the unreviewed areas.

## G. Production readiness (evidence-based)
Verified: UACL lifecycle, auth, kill switch, tenant isolation, state bounds, research hardening and Victus control-flow fixes by automated tests. Uncertain: behaviour under a real server, real Postgres and real network (not run here); multi-instance deployment; the unreviewed modules. Needs operational work: set `UACL_ADMIN_KEY`, `UACL_WORKER_KEY`, `VICTUS_ADMIN_TOKEN`, persistent volume paths for `VICTUS_AUDIT_FILE`/`VICTUS_SAFETY_STATE_FILE`, run `npm install && npm test` in CI, a staging run with a real worker, load testing, and an external security review before treating this as production-ready.
