# Victus World Model (v12)

Victus World Model is a structured, tenant-scoped graph for representing the state Victus reasons about.

## Core entity types

- USER
- PROJECT
- TASK
- KNOWLEDGE
- RESOURCE
- TOOL
- DEPENDENCY
- EVENT
- RESULT

## Relationships

The graph supports a bounded set of explicit relationships such as `OWNS`, `CONTAINS`, `DEPENDS_ON`, `USES`, `PRODUCES`, `REFERENCES`, `TRIGGERS`, `ASSIGNED_TO`, `SUPPORTS`, `INVALIDATES`, `PRECEDES`, and `FOLLOWS`.

## Safety model

The World Model is **descriptive state**, not a permission system.

It cannot:

- grant a tool permission;
- change Victus safety policy;
- change UACL permissions;
- execute shell commands;
- execute tools by creating graph records;
- bypass tenant isolation;
- store obvious credentials/secrets in attributes.

Sensitive attribute keys are filtered before storage and entity/graph limits are bounded.

## Persistence

When `DATABASE_URL` is configured, entities and edges are stored in Postgres in:

- `victus_world_entities`
- `victus_world_edges`

Without Postgres, the server uses an in-memory bounded repository, preserving local development behavior.

## API

Authenticated users use the `/api/victus/world` endpoints:

- `POST /entities`
- `GET /entities`
- `GET /entities/:id`
- `POST /relations`
- `GET /entities/:id/neighbors`
- `POST /context`
- `GET /snapshot`

Every request is automatically scoped to `user:<dbUser.id>`.

## Victus integration

When `VictusEngine.runGoal()` has a `tenantId` and a World Model is configured, Victus records a descriptive TASK entity and, after completion, a RESULT entity linked by `PRODUCES`.

World Model persistence is deliberately non-critical: a World Model failure cannot cause the underlying goal execution to fail.
