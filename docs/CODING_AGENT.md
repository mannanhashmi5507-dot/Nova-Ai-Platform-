# Victus Coding Agent

## Depth

`/api/dev/code` accepts `depth`:

- `fast` — one model pass plus deterministic preflight.
- `deep` — plan → implementation → verification, with a revision pass when verification starts with `REVISE`.

The orchestration endpoint uses `deep` automatically for coding requests.

## Modes

Existing modes remain available: `explain`, `fix`, `review`, `refactor`, `docs`, `generate`, `test`, `scaffold`.

Additional engineering modes:

- `architect` — production architecture, interfaces, data model, scaling, security, observability, rollout.
- `optimize` — evidence-based performance optimization and benchmark planning.
- `security` — application-security review with severity, evidence, and remediation.
- `migrate` — compatibility-aware migrations with rollback and test planning.

Before the model pass, Victus performs source-text preflight for language, size/complexity, symbols, test/async signals, and common security-sensitive patterns. This preflight is advisory and does not execute the supplied source code.
