/**
 * The get-or-load family on `StoreManager` — pool-first lookups with on-
 * demand fetch fallback. All generic over `T extends BaseModel`.
 *
 *   getOrLoadById(modelName, id)
 *   getOrLoadCollection(modelName, indexKey, value)
 *   getOrLoadAll(modelName, { syncGroups? })
 *
 * The first three are the pool-first single-id, bulk-id, and indexed-
 * collection lookups. The fourth triggers a Full bootstrap fetch for the
 * model (optionally scoped to
 * sync groups), tracks coverage in `partialIndexCoverage` under the `"*"`
 * sentinel `indexKey`, and reuses the cache on subsequent same-scope calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestActivity, TestNote } from "./fixtures";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

describe("StoreManager.getOrLoad family", () => {
  it("getOrLoadById is generic and returns a typed model", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi
      .fn()
      .mockResolvedValue([{ id: "n1", content: "hello", taskId: "t1" }]);
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const note = await manager.getOrLoadById<TestNote>("TestNote", "n1");
    expect(note?.id).toBe("n1");
    expect(note?.content).toBe("hello");
  });

  it("getOrLoadByIds is generic and bulk-fetches missing ids in one call", async () => {
    // Verifies the bulk path: pool-first, IDB next, then a single
    // `onDemandBatchFetcher` call for the still-missing subset (one
    // server request instead of N).
    const adapter = new MemoryAdapter();
    const batchFetcher = vi
      .fn()
      .mockResolvedValue([
        { id: "n1", content: "one", taskId: "t1" },
        { id: "n2", content: "two", taskId: "t1" },
        { id: "n3", content: "three", taskId: "t1" },
      ]);
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandBatchFetcher: batchFetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const notes = await manager.getOrLoadByIds<TestNote>("TestNote", [
      "n1",
      "n2",
      "n3",
    ]);
    expect(notes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
    expect(batchFetcher).toHaveBeenCalledTimes(1);
    expect(batchFetcher.mock.calls[0]).toEqual([
      "TestNote",
      ["n1", "n2", "n3"],
    ]);
  });

  it("getOrLoadCollection is generic and returns a typed collection", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi
      .fn()
      .mockResolvedValue([{ id: "a1", taskId: "t1", text: "x" }]);
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const items = await manager.getOrLoadCollection<TestActivity>(
      "TestActivity",
      "taskId",
      "t1",
    );
    expect(items.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("StoreManager.getOrLoadAll", () => {
  it("returns pool contents for Instant models without a server hit", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: { TestNote: [{ id: "n1", content: "x", taskId: "t1" }] },
    });
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    const notes = await manager.getOrLoadAll<TestNote>("TestNote");
    expect(notes.map((n) => n.id)).toEqual(["n1"]);
    // No additional bootstrap call — Instant models are already loaded.
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("issues a Full fetch for Lazy/Partial models on first call, caches on second", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, options) => {
      const models: Record<string, Record<string, unknown>[]> = options?.onlyModels?.includes(
        "TestActivity",
      )
        ? {
            TestActivity: [
              { id: "a1", taskId: "t1", text: "x" },
              { id: "a2", taskId: "t2", text: "y" },
            ],
          }
        : {};
      return { lastSyncId: 0, subscribedSyncGroups: [] as string[], models };
    });
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    const first = await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(first.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]?.onlyModels).toEqual(["TestActivity"]);
    expect(bootstrap.mock.calls[0][1]?.syncGroups).toBeUndefined();

    // Second call hits cache — no second bootstrap fetch.
    const second = await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(second.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    // The model now appears in `loadedModels` for SSE catchup-URL purposes.
    expect([...adapter.loadedModels]).toContain("TestActivity");
  });

  it("scopes the Full fetch by syncGroups when provided", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {
        TestActivity: [{ id: "a-team-A", taskId: "t1", text: "x" }],
      },
    }));
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]?.syncGroups).toEqual(["team-A"]);

    // Same scope hits cache.
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);

    // Different scope re-fetches.
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-B"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(bootstrap.mock.calls[1][1]?.syncGroups).toEqual(["team-B"]);
  });

  it("encodes scope per-element so comma-bearing IDs don't collide", async () => {
    // `["a,b"]` and `["a", "b"]` would both `.join(",")` to `"a,b"`. The
    // engine encodes per-element (`encodeURIComponent`) before joining, so
    // `["a,b"]` becomes `"a%2Cb"` while `["a", "b"]` becomes `"a,b"` —
    // distinct cache keys.
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: { TestActivity: [] as Record<string, unknown>[] },
    }));
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["a,b"],
    });
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["a", "b"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("skips the IDB scan on cache-hit when the model was already hydrated this session", async () => {
    const adapter = new MemoryAdapter();
    const readSpy = vi.spyOn(adapter, "readAllModels");
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: {
        TestActivity: [{ id: "a1", taskId: "t1", text: "x" }],
      },
    }));
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    readSpy.mockClear();

    // First call: fetches + hydrates from response.
    await manager.getOrLoadAll<TestActivity>("TestActivity");
    const firstReads = readSpy.mock.calls.length;

    // Second call: same scope, cache hit — should NOT re-read the IDB store.
    await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(readSpy.mock.calls.length).toBe(firstReads);
  });

  it("treats syncGroups as set-equal regardless of order", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: { TestActivity: [] as Record<string, unknown>[] },
    }));
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A", "team-B"],
    });
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-B", "team-A"],
    });
    // Same set, same coverage entry — only one server fetch.
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
});
