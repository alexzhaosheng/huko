# Resume

> `server/task/resume.ts` handles task recovery after process interruption.

See [architecture.md](../architecture.md) for cross-module principles.

## Goal

Resume should make persisted state safe to continue or inspect after a crash, kill, or daemon restart.

## Current Strategy

The current recovery behavior is conservative:

- Detect tasks that were not in a terminal status.
- Mark tasks failed when they cannot be safely continued.
- Synthesize tool results where needed to preserve tool-call/result pairing.
- Filter elided entries so rebuilt LLM context is valid.

Full loop continuation is future work.

## Orphan States

Resume must account for:

| State | Recovery idea |
|---|---|
| `waiting_for_reply` | Re-present the checkpoint to the user instead of calling the LLM |
| `waiting_for_approval` | Re-present approval state |
| `running` with active tool | Inject a synthetic interrupted tool result or mark failed |
| `running` during LLM call | Mark failed unless enough state exists to retry safely |

## Pairing Constraint

The LLM context must never contain an assistant tool call without a corresponding tool result. Resume owns the cleanup when crashes interrupt that sequence.

## Boundaries

- Resume reconstructs safe state.
- `TaskLoop.run()` should not know whether a task came from resume.
- Persistence remains the source of truth.

## Pitfalls

- Do not blindly continue an unknown in-flight tool. It may have already caused side effects.
- Do not drop only one side of a tool-call/result pair.
- Do not ask the LLM again for a checkpoint that should be answered by the user.
- Do not hide resume failures from CLI users; make the state explicit.

## Verification

```bash
npm run check
npm test
```

Tests should simulate interrupted tasks and assert valid rebuilt context.

## See Also

- [task-loop.md](./task-loop.md)
- [pipeline.md](./pipeline.md)
- [persistence.md](./persistence.md)
