# Victus Internet Layer

The Victus Internet Layer is a provider-independent, read-only internet access plane for Nova AI.

## What it does

- Routes web reads through a local egress node or configured remote relay nodes.
- Chooses nodes using success rate, latency, load, weight, and circuit-breaker state.
- Automatically fails over when a node fails.
- Keeps a bounded response cache with stale-on-error support.
- Prevents credentials in URLs, non-standard ports, private/reserved targets, and unsafe HTTP protocols.
- Supports a server allowlist (`VICTUS_INTERNET_ALLOWLIST`) or an explicit public-internet mode (`VICTUS_INTERNET_ALLOW_PUBLIC=true`).
- Preserves the existing Victus safe fetcher protections on direct and relay nodes.
- Uses a dedicated `internet` kill-switch scope.
- Keeps relay credentials out of status responses.

## Architecture

```text
Nova AI
   |
 Victus
   |
 Internet Gateway
   |------ local-egress
   |------ relay node A
   |------ relay node B
   |
 Public Internet
```

The gateway does not use a vendor SDK. A provider is just a node with a small HTTP relay contract, so the topology can mix different infrastructure vendors.

## Environment

```text
VICTUS_INTERNET_ALLOWLIST=example.com,docs.example.org
VICTUS_INTERNET_ALLOW_PUBLIC=false
VICTUS_INTERNET_LOCAL_ENABLED=true
VICTUS_INTERNET_CACHE_TTL_MS=30000
VICTUS_INTERNET_STALE_TTL_MS=300000
VICTUS_INTERNET_MAX_BYTES=2097152
VICTUS_INTERNET_MAX_ATTEMPTS=4
VICTUS_INTERNET_ADMIN_KEY=<long-random-secret>
VICTUS_INTERNET_NODES=[{"id":"relay-a","type":"relay","url":"https://node.example.com","provider":"generic","region":"global","key":"...","weight":10}]
```

Use `VICTUS_INTERNET_ALLOW_PUBLIC=true` only when broad public-web access is intentionally required. SSRF protections remain enabled.

## API

Authenticated users:

- `GET /api/victus/internet/status`
- `GET /api/victus/internet/nodes`
- `POST /api/victus/internet/fetch` with `{ "url": "https://...", "domains": ["example.com"], "region": "global" }`

Admin-only:

- `POST /api/victus/internet/nodes`
- `DELETE /api/victus/internet/nodes/:id`
- `POST /api/victus/internet/cache/clear`

Admin node changes are in-memory. Put the topology in `VICTUS_INTERNET_NODES` for restart-safe configuration.

## Relay node

A lightweight standalone relay can be run with:

```bash
npm run victus:internet-node
```

Configure:

```text
VICTUS_INTERNET_NODE_PORT=5090
VICTUS_INTERNET_NODE_KEY=<long-random-secret>
VICTUS_INTERNET_ALLOWLIST=example.com,docs.example.org
```

The node exposes:

- `GET /health`
- `POST /relay`

The relay is read-only and uses the same safe research fetcher, including redirect, DNS/SSRF, response-size, and prompt-injection defenses.

## Power and independence

This layer can reduce duplicated network work by caching results, avoiding unhealthy nodes, and routing requests intelligently. It does **not** make electricity usage zero and does not remove the need for infrastructure somewhere. Its independence comes from avoiding a single provider dependency and allowing multiple interchangeable nodes.
