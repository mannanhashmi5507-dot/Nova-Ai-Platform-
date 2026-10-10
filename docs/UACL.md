# Victus Cloud — Universal AI Compute Layer (UACL)

UACL is a scheduler/broker. Clients submit **structured jobs**; **workers** that you run (a local machine, a rented GPU, …) claim and execute them and report results. UACL does not create compute and has no shell/command-execution primitive — a job `spec` is plain JSON data.

State is **in memory**. After an API restart all jobs/workers are gone: workers re-register automatically (the agent does this on its next heartbeat) and clients must resubmit. Persistence is not implemented.

## Job lifecycle

```
queued → assigned → running → succeeded | failed | cancelled | expired
assigned/running → queued      (worker lost; at most maxAttempts, default 3, then failed)
```

- A worker runs at most `capabilities.maxConcurrentJobs` jobs (default 1).
- Queued/assigned jobs expire after their TTL (default 30 min). Running jobs expire after `maxRuntimeMs` (default 30 min, cap 6 h).
- A worker silent for 45 s is marked offline and its jobs are re-queued. A background sweep (every 5 s) does this even if nobody polls `/status`.
- Finished jobs are kept for 1 h / last 1000, then discarded, so the queue never fills up with history. `UACL_MAX_QUEUE` bounds *active* jobs.
- Limits: spec ≤ 256 KB, worker metadata ≤ 8 KB, result ≤ 1 MB (an oversized/invalid result fails the job), 8 active jobs per tenant (queued jobs count).

## Authentication

| Caller | Credential |
|---|---|
| Client (submit/get/cancel) | logged-in user; jobs are scoped to that user. The request body cannot choose the tenant. Non-admins' priority is capped at 50. |
| Admin (`/events`, act for any tenant) | header `x-victus-admin-key` = `UACL_ADMIN_KEY` |
| Worker enrollment (`register`) | header `x-victus-worker-key` = `UACL_WORKER_KEY` |
| Worker (heartbeat/claim/complete/fail) | header `x-victus-worker-token` — a **per-worker credential returned once by `register`**. The shared enrollment key is not a worker identity. |

All secret comparisons are constant-time. **If a key is not configured the endpoint refuses (503)** — it is never left open. For local development only, `UACL_ALLOW_INSECURE_DEV=true` (ignored when `NODE_ENV=production`) opens admin/enrollment.

A live worker id cannot be taken over: re-registering requires the worker's current credential (which rotates). A dead worker's id can be replaced; its jobs are re-queued.

## Kill switch (scope `compute` or `all`)

| Action | While stopped |
|---|---|
| Submit job, register worker, claim job | **blocked (423)** — enforced in the HTTP layer *and* inside the scheduler core; nothing new is assigned |
| Cancel job, heartbeat, complete, fail | **allowed** — running work can finish, shutdown and recovery stay possible |

Releasing the switch resumes scheduling of waiting jobs. Set `VICTUS_SAFETY_STATE_FILE` so a stop survives a restart (`GET /api/victus/safety/status` shows `persisted`).

## Endpoints (all defined in `src/victus/cloud/routes.js`)

- `GET  /api/victus/cloud/status` — aggregate counts (public)
- `GET  /api/victus/cloud/events` — admin
- `POST /api/victus/cloud/jobs` · `GET /jobs/:id` · `POST /jobs/:id/cancel`
- `POST /api/victus/cloud/workers/register` · `/workers/:id/heartbeat` · `/workers/:id/claim`
- `POST /api/victus/cloud/workers/:id/jobs/:jobId/complete` · `/fail` (optional `attempt` rejects stale reports)

Heartbeat responses include `cancelJobIds` so a worker learns a running job was cancelled.

Error codes: 401 bad credentials, 403 not your job, 404 unknown, 409 conflict/illegal transition, 413 too large, 422 invalid input, 423 kill switch, 429 tenant limit, 503 not configured / queue full.

## Worker agent (`scripts/uacl-worker.js`, `src/victus/cloud/workerAgent.js`)

Runs one job at a time (configurable), re-registers if the broker lost its state, retries result reports on network/5xx errors (a lost report is never turned into a job failure), aborts the handler on cancel or timeout (`handler(job, { signal })`), refuses to send credentials over plain `http` to non-local hosts, and drains running jobs on SIGTERM.

## Environment

`UACL_ENABLED` (default true) · `UACL_WORKER_KEY` · `UACL_ADMIN_KEY` · `UACL_MAX_QUEUE` (50–5000, default 1000; invalid values fall back to 1000) · `UACL_ALLOW_INSECURE_DEV` · worker: `UACL_URL`, `UACL_WORKER_ID`, `UACL_WORKER_KEY`, `UACL_PROVIDER`, `UACL_REGION`, `UACL_PRICE_PER_HOUR`, `UACL_ACCELERATORS`, `UACL_*_GB`, `UACL_CPU_CORES`.

## Known limitations

- In-memory only (see above). Single API instance: running several instances would give each its own queue.
- A worker's self-reported capabilities and price are trusted (clamped to sane bounds, but not verified).
- No provider adapter yet: UACL does not provision hardware.
- A worker holding a job can see its `spec`; run only workers you trust with that tenant's data.
