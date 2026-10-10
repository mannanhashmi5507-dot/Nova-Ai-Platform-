# Victus Mission Engine (v13)

The Mission Engine turns a user-approved, structured goal into a bounded DAG of tasks and executes only registered ToolBus actions. It is the orchestration layer between Victus control and the World Model/tools.

## Architecture

`Goal -> Mission -> Tasks + Dependencies -> Approval/Safety -> ToolBus -> Verification -> World Model`

## Safety boundaries

- No shell or arbitrary command execution is added.
- Only actions already registered in the Victus `ToolBus` can run.
- Existing ToolBus policy and high-risk human-approval checks remain in force.
- The Victus kill switch is checked before mission execution and before every task.
- Missions and tasks are tenant-scoped.
- Task counts, input sizes, result sizes, attempts, concurrent runs, and execution cycles are bounded.
- The World Model is descriptive and non-critical; World Model failures cannot execute or authorize actions.
- Cancellation aborts the mission runner. Tools that honor `context.signal` can stop early; the engine does not pretend every third-party tool is forcibly interruptible.

## Task lifecycle

`PENDING -> RUNNING -> SUCCEEDED`

Failures may use `retry`, `skip`, or `stop`. Unsuccessful dependencies block downstream tasks.

## API

Authenticated users:

- `POST /api/victus/missions`
- `GET /api/victus/missions`
- `GET /api/victus/missions/:id`
- `POST /api/victus/missions/:id/start`
- `POST /api/victus/missions/:id/pause`
- `POST /api/victus/missions/:id/cancel`

Starting a mission can include `approved: true` or `X-Victus-Mission-Approval: true`. This is passed as the human-approval context used by the existing ToolBus for high-risk tools.

## World Model integration

Each mission is represented as a `PROJECT` with `kind: MISSION`. Its tasks become `TASK` entities, task dependencies become `DEPENDS_ON` edges, and verified task outputs become `RESULT` entities linked with `PRODUCES`.

## Persistence

When Postgres is configured, missions are stored in `victus_missions`. In-memory storage is used without Postgres.
