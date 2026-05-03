# Engine maintainer notes

## Keep docs current with behavior

When a code change crosses one of the surfaces below, update the matching doc in the same commit (or the immediately-following one). Don't let docs drift across multiple feature commits.

| If a change touches… | Update… |
|---|---|
| `StorageAdapter` interface, bootstrap-type logic, schema migration, IDB layout | `agent-docs/03-indexeddb-and-persistence.md` |
| `LoadStrategy` semantics, full-vs-partial fetch rules, what ships in a bootstrap payload | `agent-docs/04-lazy-loading.md` |
| SSE URL shape, delta-packet structure, sync-group activation, ModelStream behavior | `agent-docs/07-realtime-sync.md` |
| Public types in `core/types.ts`, new `EngineErrorContext` kinds, new `StoreManagerConfig` fields | `README.md` |
| New decorator, new property option, change to existing decorator semantics | `agent-docs/01-models-and-decorators.md` + README "Define your models" |
| Headless / `MemoryAdapter` API, agent reactivity APIs | `agent-docs/09-headless-and-agents.md` |
| React hook signatures or `<SyncProvider>` config | `agent-docs/08-react-integration.md` + README "React quick start" |

The README is user-facing — keep it terse and accurate. The agent-docs are deeper; update the section that already covers the topic instead of inventing new ones.

## Always run /simplify before commit

Standing directive — applies to every commit, not just large changes.

## No `Co-Authored-By` lines in commits

Per user memory.
