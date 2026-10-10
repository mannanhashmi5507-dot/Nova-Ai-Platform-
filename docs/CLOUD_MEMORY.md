# Victus Cloud Memory

Victus Cloud Memory is an application-level distributed memory/cache layer. It **does not pretend remote internet memory is as fast as physical RAM**.

## Tiers

1. **Local hot tier** — process memory for frequently accessed values.
2. **Remote cloud tier** — authenticated internet-connected memory nodes for colder or overflow data.
3. **Stale fallback** — bounded local stale data can remain available if remote nodes fail.

## Data path

```text
Victus / Nova
    |
    +--> Local Hot Cache
    |
    +--> Cloud Memory Router
             |
             +--> Memory Node A
             +--> Memory Node B
             +--> Memory Node C
```

## Security

- Remote values are encrypted client-side with AES-256-GCM before leaving the Victus process.
- Memory nodes store encrypted envelopes and cannot read the application value.
- Every remote node requires its own shared authentication secret.
- Production remote nodes must use HTTPS unless private-node development is explicitly enabled.
- Tenant namespaces are hashed before being used as remote storage identifiers.
- Node storage is bounded by entry and byte limits and expires data automatically.
- Remote failures use circuit breaking; a node outage does not automatically take down all memory operations.
- The `memory` kill-switch scope can stop writes/deletes while leaving reads available for graceful degradation.

## Important limitation

Internet latency is orders of magnitude higher than physical RAM latency. This system is for **tiered application memory/cache**, not a drop-in replacement for DDR/LPDDR RAM or OS swap.

The appropriate use cases are context, retrieval results, task state, cached tool results, working sets, and other data where milliseconds of network latency is acceptable.

## Configuration

- `VICTUS_CLOUD_MEMORY_ENABLED=true|false`
- `VICTUS_CLOUD_MEMORY_KEY=<32-byte hex or base64 key>`
- `VICTUS_CLOUD_MEMORY_NODES=<JSON array of {id,url,provider,region,key,weight}>`
- `VICTUS_CLOUD_MEMORY_REPLICAS=1`
- `VICTUS_CLOUD_MEMORY_REMOTE_REQUIRED=false`
- `VICTUS_CLOUD_MEMORY_LOCAL_TTL_MS=60000`
- `VICTUS_CLOUD_MEMORY_STALE_TTL_MS=300000`
- `VICTUS_CLOUD_MEMORY_MAX_LOCAL_ENTRIES=2000`
- `VICTUS_CLOUD_MEMORY_MAX_LOCAL_BYTES=67108864`
- `VICTUS_CLOUD_MEMORY_MAX_VALUE_BYTES=2097152`
- `VICTUS_CLOUD_MEMORY_NODE_TIMEOUT_MS=5000`
- `VICTUS_CLOUD_MEMORY_NODE_MAX_ATTEMPTS=3`
- `VICTUS_CLOUD_MEMORY_NODE_PORT=5091` (for a node)
- `VICTUS_CLOUD_MEMORY_NODE_KEY=<node secret>` (for a node)

Generate a master key with a CSPRNG, for example `openssl rand -hex 32`.

## Relay node

Run:

```bash
npm run victus:cloud-memory-node
```

The node is deliberately storage-only: it never decrypts user memory and exposes no arbitrary code execution.
