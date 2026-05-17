# Devtools — discussion notes

Pause point: brainstorm landed, no implementation started. Resume by picking which tool(s) to build first.

## Where we are in the broader work

Schema-first authoring is shipped end-to-end (see [`RFC-schema-first-authoring.md`](RFC-schema-first-authoring.md) for the full design). Seven commits on `main`:

| Commit | What |
|---|---|
| `e2e5bcf` | `defineSchema` / `entity` / `link` / `s.*` builders + `InferEntity`, `InferCreateInput` |
| `b9c3304` | `compileSchema` → `ModelRegistry` (synthetic ctors, schema-version hash, cross-validation); shared helpers extracted to `core/refAccessors.ts` and `core/hash.ts` |
| `1d3aa50` | `createStore({ schema, storeManager })` — typed namespaces, `findById/create/update/delete` |
| `2ed1dd4` | `extend(schema, ...)` — pure descriptors for computed + actions; record types carry merged extension members |
| `e27a94b` | `entity({ external: true })` — schema entities can reference decorator-defined classes by registry name |
| `a31a975` | `store.<entity>.seed(...)` + `fromZod` / `entityFromZod` (Zod 4 optional peer dep) |

Test count: 551 across 36 files, all green.

**Still deferred from the schema RFC** (independent of devtools):
- `store.<entity>.query(...)` and the multi-entity InstaQL document
- OpenAPI → schema importer
- Many-to-many through-table sugar
- Decorator → schema reverse direction (a decorator class linking to a schema entity)

## Why devtools is reachable now

Schema-first authoring made the schema descriptor plain data: `defineSchema(...)` returns a serializable object, so a devtool can render it without scraping `ModelRegistry`. Combined with the existing runtime — `ObjectPool`, `TransactionQueue`, `SyncConnection`, `BootstrapPhase` — we already have the introspection surface; what's missing is a UI that renders it.

## The brainstorm — tiered

### Tier 1 — biggest debugging wins

1. **Pool inspector.** Live tree of every model in `ObjectPool`, expandable to fields + resolved relations + active `RefCollection`/`BackRef` state. Filter by model name, jump to record by id, copy as JSON. *Single highest-leverage tool — most "where did my data go" bugs collapse to "is it in the pool?"*
2. **Transaction queue timeline.** Chronological rows: pending / executing / completedButUnsynced / completed / failed. Each row shows applied diff, batchId, undoable group, round-trip latency. Click to see the serialized payload.
3. **Sync stream viewer.** Live SSE delta packets parsed into `(action, model, id, changes)`. Side-by-side before/after pool view. Filter by model.

### Tier 2 — schema-aware (cheap because schema is now plain data)

4. **Schema graph visualizer.** Render `SchemaDef` as entity nodes + link arrows. Reads directly from the schema descriptor.
5. **Cascade preview.** Click a record → "deleting this cascades to N, nullifies M, is blocked by K restricts."
6. **Sync-group monitor.** Subscribed groups, last-delta times, in-flight partial-index loads, current `lastSyncId`.

### Tier 3 — performance

7. **Load profiler.** Every `getOrLoadById` / `getOrLoadByIds` / `getOrLoadCollection` with caller, query, hit/miss, latency. Catches N+1.
8. **Reactivity tracer.** "Why did this component re-render?" — surface which MobX observable a render reaction touched.
9. **Bootstrap timeline.** Gantt-style view of `BootstrapPhase` transitions with durations.

### Tier 4 — debug-time actions

10. **Snapshot + restore.** Dump pool + transactionQueue to JSON, restore later.
11. **SSE record/replay.** Record incoming packets, replay locally for race-condition repros.
12. **Schema-version diff.** When `schemaHash` changes, show which entity/property triggered it.

## Delivery format

- **React overlay via `SyncProvider`** — ships fast, works in any host app, no extension review. Best V1.
- **Chrome DevTools extension panel** — polished but adds Manifest/MV3 cost. Build after the overlay proves valuable.
- **Headless `dumpDebugState()` API** — a function returning a JSON snapshot of the engine's runtime state. Build this first; everything else projects from it.

## Recommended starting point (where the conversation left off)

Build a single `dumpDebugState(storeManager)` (#13) that returns roughly:

```ts
interface DebugSnapshot {
  pool: { [modelName: string]: { [id: string]: SerializedRecord } };
  transactions: {
    pending: SerializedTransaction[];
    executing: SerializedTransaction[];
    completed: SerializedTransaction[];
    failed: SerializedTransaction[];
  };
  syncGroups: { id: string; lastSyncId: number; subscribedAt: number }[];
  schema: SchemaDef | null;        // from createStore if available
  registry: ModelMeta[];           // canonical registry shape
  bootstrap: { phase: BootstrapPhase; startedAt: number; phaseTimings: ... };
  lastSyncId: number;
}
```

Then layer #1, #2, #3 as a `<SyncDevtools />` React overlay reading from it. ~200 lines of UI code, zero dependencies on browser-extension infra.

After that, #4 (schema graph) and #5 (cascade preview) come naturally because they're pure-function projections of `schema` + `registry`.

## Open questions to resolve when we resume

1. **Where does `dumpDebugState` live?** `core/index.ts` (always exported) or a separate `zerodrift/devtools` subpath that tree-shakes out of prod bundles? Probably the latter — devtool helpers shouldn't ship to users by default.
2. **Should `<SyncDevtools />` be in `zerodrift/react` or its own `zerodrift/devtools/react` subpath?** Same tree-shaking concern.
3. **Authorization** — should `dumpDebugState` redact anything? The pool may contain user-content. Probably gate behind `process.env.NODE_ENV !== "production"` plus an explicit `enableDebug` flag.
4. **Performance** — running the devtool overlay on a 100k-record pool would be terrible. Need pagination or virtualization in the pool inspector from day one.
5. **Reactivity for the overlay itself** — should the overlay subscribe to `objectPool` events, or poll `dumpDebugState` on a timer? Subscriptions give live updates; polling is simpler.
6. **Headless usage** — agents need a CLI/JSON shape, not a React overlay. `dumpDebugState` already covers this; worth confirming we don't duplicate the surface in two places.

## What to type when resuming

> "Pick up the devtools work — start with `dumpDebugState`."

That should give whoever resumes (you or me) enough context to jump straight to implementing #13, then layering #1–#3 on top. The full brainstorm above is the menu of follow-on work.
