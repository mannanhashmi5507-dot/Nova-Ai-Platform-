# Nova AI + Victus v14 — Full System Audit

Method: source inspection of every Victus module, the live request wiring in `src/index.js`, the schema, the Python model scaffold, route inventory, plus executable probes and tests. Documentation was not trusted. **Not run:** the server itself (express/pg are not installed in the audit sandbox and there is no network), a real PostgreSQL, a real GPU worker, the browser frontend. Anything that depends on those is marked *(not run-verified)*.

## 0. Changes made during the audit (only two, both minimal)
1. `src/index.js` — the catch-all `app.get('*')` was registered **before** the safety control-plane block, so by Express routing order every `GET /api/victus/safety/status`, `/audit`, `/audit/verify`, `/proposals`, `/proposals/:id` returned the HTML page. (This was introduced by the v7 safety build; it was never caught because the server was never started.) Catch-all moved after every route. Guarded by a static test. *(not run-verified live)*
2. `src/victus/internet/gateway.js` — `status()` referenced an undefined `staleTtlMs` (ReferenceError). It broke `GET /api/victus/internet/status` and the startup log line. Fixed (`this.staleTtlMs`).
Plus `test/victusAuditSecurity.test.js` (30 tests: 18 guards that pass, 12 `todo` tests that encode confirmed gaps) and this report. No safety restriction was relaxed.

## 1. Test results
`node --test`: **543 tests · 521 pass · 10 fail · 0 skipped · 12 todo.**
- CORE FAILURES: **0**.
- ENVIRONMENT/DEPENDENCY FAILURES: **10** — 9 files need `pg` (all pass, 63/63, with a stub `pg`), 1 file (`victusWorldModelRoutes`) needs `express`. These are *unavailable*, not passing.
- EXPECTED LIMITATIONS: 12 `todo` tests (F-01…F-12 below) fail by design until fixed.
- No lint, type-check or build step exists in the repo.
- **False-confidence test found:** `victusInternetLayer › stale cache can preserve availability…` passes only because it uses `forceRefresh:true`; the normal request path is broken (F-11).

## 2. Nova platform feature status
| Feature | Status | Where |
|---|---|---|
| Chat + streaming (SSE) | IMPLEMENTED | `POST /api/chat` (index.js), `/api/agents/:key?stream=true` |
| Multi-turn, history, search, archive, export | IMPLEMENTED (needs Postgres; no DB → client-side only) | `src/conversations/routes.js`, `/api/search`, `/api/export` |
| Multiple providers, routing, fallback, cooldown | IMPLEMENTED | `AI_PROVIDERS`, `selectProviderOrder*`, `src/aihub/router.js` |
| Context management / summaries | IMPLEMENTED | `src/victus/contextCompression.js`, `db.incrementMessagesSinceSummary` |
| User/session memory | PARTIAL — style/feedback persisted; Victus memory is in-memory | `victus/adaptive.js`, `styleModel.js` |
| File/document context | IMPLEMENTED | `src/documents/routes.js` |
| Image generation | IMPLEMENTED (Pollinations free tier; Replicate for creator tools) | `/api/image`, `/api/creator/*` |
| Video | MISSING (501/503/410 stubs) | index.js ~781-788 |
| Models interface / system status | IMPLEMENTED (`/api/health` is unauthenticated) | `/api/models`, `/api/health` |
| Usage tracking | IMPLEMENTED with DB; **silently disabled without DB** | `middleware/usageGate.js` |
| Billing | IMPLEMENTED, webhook signature verified, *not run-verified* | `src/billing/*` |
| Authentication / API access | IMPLEMENTED (Google OAuth, sessions, `nova_` API keys, SAML) | index.js, `enterprise/*` |

## 3. Victus control — is it on the live path?
| Component | Live? |
|---|---|
| `VictusEngine.runGoal` (plan→execute→verify→learn) | **Yes**, for coding only (`/api/dev/code`, `/api/orchestrate`) |
| Self-monitor, experience, telemetry | Yes (coding path), in-memory |
| Safety kernel (kill switch, audit, proposals) | Yes; admin GET routes were shadowed (fixed, §0) |
| Research | Yes (`POST /api/victus/research`) |
| World Model | Mounted as API; **the engine writes to it only if a `tenantId` is passed, and the live coding path passes none → effectively API-only.** Nothing reads it to make decisions. |
| Mission Engine | Mounted, **but cannot do useful work** (F-14) |
| Internet Layer | Mounted as its own API; **research does not use it** (separate fetch path) |
| UACL | Mounted; no Victus component submits jobs to it |
| Victus Model | Optional provider (`VICTUS_MODEL_URL`), first in the chain when set |
Victus is a coding-path orchestrator plus a set of side APIs; the full pipeline in the brief (World Model → Mission → Model → Internet → UACL) is **not wired end-to-end**.

## 4. Findings
Format: SEVERITY · FILE · LOCATION — problem / impact / evidence / fix / test. IDs match the `todo` tests.

**F-00 HIGH (FIXED)** · `src/index.js` · catch-all order — GET safety routes unreachable → admins could not read kill-switch status, audit log, audit verification or the approval queue. Evidence: static order check. Fix: applied. Test: `no route is registered after the catch-all`.

**F-00b HIGH (FIXED)** · `internet/gateway.js` · `status()` — ReferenceError. Test added.

**F-01 HIGH** · `internet/gateway.js` · `fetch()/_recordFailure` — every error (404, blocked URL, oversize) counts as a *node* failure. Impact: any signed-in user opens the circuit on all nodes with 3 requests for a missing page; the layer is down for 30 s, repeatably; each bad URL is also tried on up to 4 nodes. Evidence: probe — after 3 requests for `/missing*`, both nodes `CIRCUIT OPEN`, next valid request → `NO_NODES`. Fix: only transport errors (network, timeout, 5xx, relay errors) affect node health; 4xx/policy/size errors return immediately without failover. Test: `GAP F-01`.

**F-02 HIGH** · `internet/gateway.js`, `internet/routes.js` — `internet` kill switch is enforced only in the `POST /fetch` route; `InternetGateway.fetch()` has no kill-switch hook. Any other in-process caller bypasses it. Fix: inject `killSwitch` into the gateway and assert `internet` at the top of `fetch()` and in `_transport`. Test: `GAP F-02`.

**F-03 HIGH** · `internet/gateway.js` · `_relayTransport` — a relay's `document` is trusted verbatim: no schema/size check (`response.json()` is unbounded), no prompt-injection filtering, extra fields kept, then cached. Impact: a compromised/untrusted relay (the point of "distributed") injects instructions or poisons the cache for 30 s fresh + 5 min stale. Evidence: probe. Fix: whitelist fields, cap body size, re-run `filterPromptInjection`, force `url` to the requested one. Test: `GAP F-03`.

**F-04 HIGH (public mode) / MEDIUM** · `internet/node.js` · `relay()` — authentication is skipped when `VICTUS_INTERNET_NODE_KEY` is empty, and the comparison is not constant-time. With public-internet mode this is an open fetch proxy. Fix: refuse to start/serve without a secret; `timingSafeEqual`. Test: `GAP F-04`.

**F-06 HIGH** · `src/index.js` · `GET /api/victus/self-monitor` — unauthenticated; returns `recent(20)` (goal text, which includes user code excerpts, plus error/anomaly detail) to anyone. The aggregate-only view existed in v10 and was removed. Fix: aggregate-only public view, detail behind admin. Test: `GAP F-06`.

**F-13 HIGH (if token has private scope) / MEDIUM** · `index.js` · `POST /api/dev/github/file|tree` — no auth, no usage gate; uses the server `GITHUB_TOKEN`. Anyone can read what the token can read and consume its quota. Fix: require login + usageGate, restrict to public repos unless the user connects their own token.

**F-14 HIGH (functional)** · `index.js` ~89 / `mission/engine.js` — the Mission Engine shares the coding ToolBus, whose only tool (`coding_agent`) reads `context.mode/code/language`, which missions never supply. Evidence: executing it with a mission-style context throws `mode must be one of: explain, fix, …`. Impact: every real mission task fails; the Mission Engine cannot do anything useful in production. Fix: register mission-appropriate, individually reviewed tools (read-only first), or adapt the tool to task input.

**F-11 MEDIUM** · `gateway.js` · `_readCache` — the freshness read deletes an expired entry before the stale window is consulted, so stale-if-error never works on the normal path (only with `forceRefresh`). Evidence: probe, test passes only with `forceRefresh`. Fix: delete only after `staleUntil`. Test: `GAP F-11`.

**F-09 MEDIUM** · `mission/engine.js` + `routes.js` — routes call `startMission` without `verifyTask`; tasks with `requiresVerification:true` are marked verified (`skipped:true`). The "verification gate" is a no-op in production. Fix: refuse (or mark unverified) when no verifier is configured. Test: `GAP F-09`.

**F-08 MEDIUM** · `mission/engine.js` · `recoveryStrategy:'skip'` marks a failed task `SUCCEEDED`, so dependents (e.g. a deploy) run after a failed check. Fix: a distinct `SKIPPED` state that does not satisfy `dependsOn` unless declared. Test: `GAP F-08`.

**F-15 MEDIUM** · `mission/routes.js` — "approval" is a boolean in the same request by the same user who authored the mission; it is global to the run, not bound to a task/content hash, not audit-logged, and also becomes `context.humanApproval` that unlocks HIGH-risk tools. Fix: per-task approvals recorded in the audit log, bound to the mission version hash.

**F-10 MEDIUM** · `mission/engine.js` · `InMemoryMissionRepository.save` — no version check (Postgres has one) → lost updates when DB is off. Test: `GAP F-10`.

**F-16 MEDIUM** · `mission/engine.js` — runs inside the HTTP request, not durable: a restart or kill-switch trip mid-run leaves the mission `RUNNING` forever; `_syncWorldModel` rewrites every task and edge on each checkpoint (≈ O(tasks²) DB writes per run); tools receive the live mutable `mission`/`task` objects; the `coding` kill-switch scope does not stop mission-driven tool calls (only `all`).

**F-07 MEDIUM** · `world/model.js`, `mission/engine.js` (in-memory repos) — `tenantId:id` string keys can collide across tenants (tenant `a:b`/id `c` vs `a`/id `b:c`; reachable only if tenant ids contain `:` — routes produce `user:N`, so latent). World model: limits only apply to the in-memory repo (none with Postgres), no global tenant cap, client-chosen edge ids (PK `id` global in SQL → cross-tenant collision error), no delete API (a full tenant can never free space), raw `err.message` returned on 500. (v12 findings, unfixed.) Test: `GAP F-07`.

**F-05 MEDIUM** · gateway — no request coalescing (10 simultaneous identical fetches → 10 upstream); cache bounded by entry count, not bytes (≈0.9 GB worst case: 500 × ~1.9 MB; measured 61 MB for 20 pages). Test: `GAP F-05`.

**F-17 MEDIUM** · `internet/routes.js` — `GET /nodes` and `/status` expose relay URLs and last errors to any signed-in user; no per-user quota, no audit entry per fetch, `forceRefresh` open to all users.

**F-18 MEDIUM** · persistence — Victus memory, knowledge graph, experience, telemetry, self-monitor are **in-memory only**; the schema tables `victus_memory_items`, `victus_knowledge_claims`, `victus_plans`, `victus_evolution_records` are **never written by any code**. Missions and the World Model persist only when `DATABASE_URL` is set and fall back to memory silently (no log). Audit log and kill-switch state persist only if `VICTUS_AUDIT_FILE` / `VICTUS_SAFETY_STATE_FILE` are set (ring buffer of 5000 otherwise).

**F-19 LOW** — gateway URL check does not recognise bracketed IPv6 (`[::1]`, `[::ffff:127.0.0.1]`, `[fd00::1]`); direct nodes are still protected by `SafeResearchFetcher` (verified), relay nodes depend on the relay. `status()` crash is fixed. Failed missions leave dependents `PENDING` (F-12). `/api/health` unauthenticated and lists configured providers. CSP disabled (`helmet({contentSecurityPolicy:false})`). Global JSON limit 10 MB. Four separate admin credential schemes (`ADMIN_EMAILS`, `VICTUS_ADMIN_TOKEN`, `UACL_ADMIN_KEY`, `VICTUS_INTERNET_ADMIN_KEY`). `serve.py` auth is optional and not constant-time. Evolution controller code is loaded through the `src/victus/index.js` barrel (unreachable from any route).

## 5. Safety architecture & self-modification (adversarial review)
Verified by tests and source scan — **holds today**:
- No `child_process`, `eval`, `new Function`, `vm`, runtime env mutation, package install, or filesystem write exists outside the safety state/audit files (static test over `src/` and `scripts/`).
- Exactly one ToolBus tool is registered, by code, at startup; no route can register tools; the evolution controller is unreachable from any route.
- Unknown actions are rejected (`unknown tool`); HIGH-risk tool types need a human-approval flag; a malformed mission (cycle, unknown/self dependency, duplicates, oversize) is rejected; a mission cannot run an unregistered action.
- Victus-submitted proposals touching the locked control plane (including the new mission/internet/world/uacl modules and `schema.sql`) are refused; Victus cannot approve, reject or mark proposals applied; the kill switch has no Victus-callable path; the audit log has no delete API and is hash-chained.
- Symlink attacks: nothing in the code resolves or opens filesystem paths from proposals, missions or tool input, so symlinks are not an attack path here.
Weak points: F-15 (approval is a request flag set by the mission author's own user, not a separate authority), F-16 (tools get mutable control objects), F-14/F-09 (the tool surface is currently too small for those to matter). Conclusion: **Victus can reason and propose; in the current code it cannot grant itself authority** — but the approval design should be tightened before any real tools are added.

## 6. Provider independence
| Dependency | Role | Replaceable? |
|---|---|---|
| OpenAI / Anthropic / Gemini / Groq / Grok / DeepSeek | OPTIONAL, fallback chain | Yes (`AI_PROVIDERS`, plus Victus/Local/My model) |
| Victus Model / LocalModel (`VICTUS_MODEL_URL`) | OPTIONAL, first in chain when set | Yes (any OpenAI-compatible server) |
| Pollinations | FALLBACK for chat and the default for images | Replaceable but a de-facto requirement for images without Replicate; free, no SLA |
| Replicate | REQUIRED for upscale / background removal | Not abstracted |
| Google OAuth | REQUIRED for login (+ guest, SAML) | Passport strategy swap |
| Stripe | REQUIRED for billing | Tightly coupled, not abstracted |
| DuckDuckGo (research search, agent tool) | OPTIONAL | Yes (search adapter function) |
| GitHub | OPTIONAL (see F-13) | — |
| Cloud/GPU | UACL is provider-neutral but has **no provider adapter** (cannot create machines) | Yes by design, nothing to replace yet |
| Storage | Postgres only; no object-storage abstraction | — |
Nova **can start and answer without OpenAI/Anthropic/Gemini keys** (startup only warns; the Victus/Local model or the Pollinations fallback serve requests) *(not run-verified)*. The Internet Layer and the research fetcher are separate fetch paths (duplication; research gets no cache/failover).

## 7. Victus Model
Exists: FastAPI OpenAI-compatible server (`serve.py`, localhost by default, optional bearer key), LoRA/PEFT SFT trainer (`train.py`, TRL), config, evaluator, prompt template, dataset validator, **10-example seed dataset**. Does **not** exist: trained weights (0 weight files, 68 KB total), evaluation results, a capable model. `MODEL_CARD.md` is honest about this. **Victus Model infrastructure exists; a capable trained Victus model does not.**

## 8. UACL (unchanged since the v10 review)
IMPLEMENTED: inference/training/evaluation/embedding job types, CPU/RAM/storage/accelerator/accelerator-memory/region/cost/preemptible matching, per-worker credentials, one-job-per-worker by default (`maxConcurrentJobs`), crash recovery with bounded retries, queue and tenant limits, size/shape validation, cancellation delivered via heartbeat, kill switch in the scheduler core and every route. NOT implemented: checkpoint/resume, provider adapters (it is a scheduler/broker only), persistence (in-memory; lost on restart), multi-instance operation, fairness beyond per-tenant caps and priority clamping.

## 9. Performance & energy (no invented numbers)
Measured: cache entries up to ~1.9 MB each (61 MB for 20), worst case ≈0.9 GB; 10 identical concurrent fetches → 10 upstream requests; 5 000 UACL jobs schedule in under 8 s (test). Likely waste: deep coding mode makes 3–5 model calls per request and a failed run repeats them; no result cache for identical coding requests; duplicate internet fetches; mission world-sync write amplification; no autoscaling so idle workers cost power. Caching and coalescing can reduce duplicate work; UACL placement can improve utilisation; **none of this is measured, and no electricity/water saving may be claimed.** Instrumentation needed: GPU-seconds and utilisation per job, worker-reported power (NVML/`nvidia-smi`), model calls and tokens per request, cache hit/miss/coalesce counters, queue wait time, idle-worker time.

## 10. Readiness (per area, with evidence)
| Area | Rating | Why |
|---|---|---|
| Security | Medium-low | strong local boundaries; F-01…F-04, F-06, F-13 open |
| Reliability | Low-medium | in-memory state, stale-cache bug, non-durable missions |
| Scalability | Low | single instance, in-memory UACL/Victus state, in-process mission runs |
| Performance | Medium | bounded work, but duplication and unbounded-bytes cache |
| Database | Medium | schema with FKs/indexes/optimistic versions; no migration tool (only `CREATE IF NOT EXISTS`), no backup/restore strategy in repo, unused Victus tables |
| API | Medium | consistent auth patterns, but shadowed routes (fixed), raw error messages, 4 admin schemes |
| Frontend | Not reviewed in depth | 2 207-line single HTML file, CSP disabled |
| Billing | Medium, not exercised | Stripe + webhook signature verification present |
| Monitoring | Low | request logger + optional Sentry; no metrics |
| Deployment | Low-medium | no Dockerfile/CI in the repo |
| Internet Layer | Not ready | F-01…F-05, F-11 |
| UACL | Staging-ready | tested lifecycle; needs persistence, provider adapters |
| Victus Control | Partial | live for coding only |
| Victus Model | Infrastructure only | no weights |

## 11. Final report
**A. Genuinely implemented:** chat/streaming/history/search/export, provider fallback, billing and auth code, safety kernel (kill switch, audit chain, proposal queue, locked paths), research fetcher hardening, UACL scheduler, coding engine + self-monitor, typed World Model store and API, mission DAG validation, internet gateway routing/failover/circuit/cache basics.
**B. Partial:** Victus pipeline (coding path only), World Model use, Mission execution, relay trust model, Victus memory persistence, usage limits without DB.
**C. Missing:** trained Victus model; mission tools; verification gate in production; checkpoint/resume and provider adapters in UACL; persistence for Victus memory/UACL; metrics/CI/Dockerfile/backup strategy; research-through-gateway integration.
**D. Vulnerabilities:** F-01, F-02, F-03, F-04, F-06, F-13 (HIGH); F-05, F-07, F-08…F-11, F-15…F-18 (MEDIUM).
**E. Architecture weaknesses:** in-memory authoritative state; four admin systems; two fetch paths; approvals are request flags; kill-switch enforced at routes in places instead of at the execution layer.
**F. Integration problems:** missions ↔ ToolBus (F-14); engine ↔ World Model (no tenant, no reads); research ↔ Internet Layer; Victus ↔ UACL.
**G. Production blockers:** F-01–F-04, F-06, F-13; set UACL/Internet/Victus admin and node keys; persistence paths for audit/kill-switch; run the DB and Express tests in CI; real-server smoke test (never done).
**H. Recommended next version (v15):** hardening only, no new features.
**I. Priority order:** (1) F-06, F-13 (data exposure) → (2) F-01, F-02, F-03, F-04, F-11 (internet layer) → (3) F-14, F-09, F-08, F-15 (mission engine usable and safe, or disable the routes until then) → (4) persistence & startup warnings (F-18) → (5) F-05, F-07, F-10, F-16/17 → (6) real-server smoke test and CI.

### Actual architecture (as implemented)
```
Browser ──> Express (helmet, CORS, session, apiKeyAuth, rate limits)
   ├─ /api/chat, /api/agents ─> provider chain (Victus/Groq/Gemini/OpenAI/Claude/…/Pollinations) ─> reply ─> Postgres (history, usage)
   ├─ /api/dev/code, /api/orchestrate ─> VictusEngine.runGoal ─> ToolBus[coding_agent] ─> provider chain
   │          └─ self-monitor / experience / telemetry (in-memory)      └─ World Model writes only if tenantId given (not in live path)
   ├─ /api/victus/research ─> SafeResearchFetcher (own fetch path, allowlist, SSRF, pinning)
   ├─ /api/victus/internet ─> InternetGateway ─> nodes: local direct | relay(HTTP) ─> cache      (not used by research)
   ├─ /api/victus/missions ─> MissionEngine ─> ToolBus[coding_agent only] ─> World Model        (tasks cannot succeed, F-14)
   ├─ /api/victus/world   ─> World Model (Postgres if DATABASE_URL, else memory)
   ├─ /api/victus/cloud   ─> UACL (in-memory) <── remote workers (per-worker tokens)             (no Victus caller)
   └─ /api/victus/safety  ─> kill switch · hash-chained audit · human-approval proposal queue
```
