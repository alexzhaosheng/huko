# Database Schema

> `server/db/` contains SQLite schema definitions and migrations used by persistence implementations.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/db/
  schema/
    infra.ts             user-global provider/model/config tables
    session.ts           project-local session/task/entry tables
  migrations.ts          migration runner helpers
  migrations/
    infra/               infra DB SQL migrations
    session/             session DB SQL migrations
```

## Split Databases

huko uses two persistence scopes:

| Scope | Default path | Contents |
|---|---|---|
| Infra | `~/.huko/infra.db` | providers, models, user-global defaults |
| Session | `<cwd>/.huko/huko.db` | sessions, tasks, entries, project state |

This split prevents project-local state from leaking into user-global configuration.

## Key Rule

API key values never enter either DB. Provider rows store only an `api_key_ref`, which is resolved at runtime by the security module.

## Schema Ownership

- Drizzle schema files are the TypeScript source of truth for query types.
- SQL migration files are the DDL source of truth for actual SQLite tables.
- When a column changes, update both the Drizzle schema and migration path.

## Migrations

Migrations are hand-authored SQL files. SQLite ALTER TABLE support is limited, so complex changes should use the create-copy-drop-rename pattern.

Migrations are applied in lexicographic order and tracked in a `_migrations` table.

## Transactions

better-sqlite3 is synchronous. Drizzle can expose promise-shaped APIs for ergonomics, but the underlying statement executes on the calling thread.

Do not pass async callbacks into DB transactions. They can commit before awaited work finishes.

## Pitfalls

- Do not store secrets.
- Do not edit already-published migrations; add a new migration.
- Do not let kernel modules import concrete DB clients. Go through persistence interfaces.
- Do not assume JSON fields behave like Postgres JSONB; this is SQLite JSON1.

## Verification

```bash
npm run check
npm test
huko db:migrate
```

## See Also

- [persistence.md](./persistence.md)
- [security.md](./security.md)
