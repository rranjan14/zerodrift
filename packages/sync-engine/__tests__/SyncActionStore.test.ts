/**
 * SyncAction store + crash-recovery tests.
 *
 * The adapter persists sync-action headers from each delta packet so the
 * TransactionQueue can survive a client crash that lands between
 * (a) the server ack'ing a transaction and (b) the matching SSE delta
 * resolving it. On restart, persisted tx records carry their awaited
 * `syncIdNeededForCompletion`; recovery checks the SyncAction store to
 * decide whether the matching delta has already been applied.
 *
 * Also covers target-deleted detection: a pending tx whose model has been
 * deleted by an SSE delta during the offline gap is dropped on recovery
 * with a `transactionDiscarded` error rather than resent.
 */

import { describe, it, expect, vi } from "vitest";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { TransactionQueue } from "@sync-engine/TransactionQueue";
import { TransactionState } from "@sync-engine/types";
import "./fixtures";

describe("StorageAdapter SyncAction store", () => {
  it("records and finds sync actions by model", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.recordSyncActions([
      { syncId: 1, modelName: "TestTask", modelId: "t1", action: "I" },
      { syncId: 2, modelName: "TestTask", modelId: "t1", action: "U" },
      { syncId: 3, modelName: "TestProject", modelId: "p1", action: "I" },
    ]);

    expect(await adapter.hasSyncAction(2)).toBe(true);
    expect(await adapter.hasSyncAction(99)).toBe(false);

    const t1 = await adapter.findSyncActionsForModel("TestTask", "t1");
    expect(t1).toEqual([
      { syncId: 1, action: "I" },
      { syncId: 2, action: "U" },
    ]);

    const missing = await adapter.findSyncActionsForModel("TestTask", "nope");
    expect(missing).toEqual([]);
  });

  it("prunes actions below a watermark", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.recordSyncActions([
      { syncId: 1, modelName: "TestTask", modelId: "t1", action: "I" },
      { syncId: 50, modelName: "TestTask", modelId: "t2", action: "I" },
      { syncId: 100, modelName: "TestTask", modelId: "t3", action: "I" },
    ]);

    await adapter.pruneSyncActionsBelow(50);

    expect(await adapter.hasSyncAction(1)).toBe(false);
    expect(await adapter.hasSyncAction(50)).toBe(true);
    expect(await adapter.hasSyncAction(100)).toBe(true);
  });
});

describe("TransactionQueue crash recovery", () => {
  it("drops a persisted awaiting-sync tx when its delta is already in the SyncAction store", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    // Pre-populate IDB as if a previous session: a tx that the server ack'd
    // (so it carries syncIdNeededForCompletion=42) AND the matching SSE
    // delta has already been persisted.
    await adapter.cacheTransaction({
      action: "U",
      modelId: "t1",
      modelName: "TestTask",
      changes: { title: { oldValue: "A", newValue: "B" } },
      syncIdNeededForCompletion: 42,
    });
    await adapter.recordSyncActions([
      { syncId: 42, modelName: "TestTask", modelId: "t1", action: "U" },
    ]);

    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const sender = vi.fn();
    queue.setSender(sender);

    const count = await queue.resendCached();

    expect(count).toBe(0); // nothing re-enqueued
    expect(queue.pendingCount).toBe(0);
    expect(queue.awaitingSyncCount).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    // The cached entry was dropped — no record left to recover next session.
    expect(await adapter.getCachedTransactions()).toHaveLength(0);
  });

  it("restores a persisted awaiting-sync tx (no resend) when the delta hasn't arrived yet", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.cacheTransaction({
      action: "U",
      modelId: "t1",
      modelName: "TestTask",
      changes: { title: { oldValue: "A", newValue: "B" } },
      syncIdNeededForCompletion: 100,
    });
    // No matching sync action yet.

    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const sender = vi.fn();
    queue.setSender(sender);

    const count = await queue.resendCached();

    expect(count).toBe(0); // not re-enqueued for sending
    expect(queue.pendingCount).toBe(0);
    expect(queue.awaitingSyncCount).toBe(1);
    expect(sender).not.toHaveBeenCalled();

    // Once the delta arrives, the tx resolves and the cache entry drops.
    queue.resolveBySync(100);
    await Promise.resolve();
    expect(queue.awaitingSyncCount).toBe(0);
    expect(await adapter.getCachedTransactions()).toHaveLength(0);
  });

  it("discards a pending update whose target was deleted while offline", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.cacheTransaction({
      action: "U",
      modelId: "t1",
      modelName: "TestTask",
      changes: { title: { oldValue: "A", newValue: "B" } },
    });
    // A delete for the same model arrived during the gap.
    await adapter.recordSyncActions([
      { syncId: 50, modelName: "TestTask", modelId: "t1", action: "D" },
    ]);

    const reportError = vi.fn();
    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    queue.setErrorReporter(reportError);
    const sender = vi.fn();
    queue.setSender(sender);

    const count = await queue.resendCached();

    expect(count).toBe(0);
    expect(queue.pendingCount).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toMatchObject({
      kind: "transactionDiscarded",
      modelName: "TestTask",
      modelId: "t1",
      action: "U",
      reason: "target-deleted",
    });
    expect(await adapter.getCachedTransactions()).toHaveLength(0);
  });

  it("re-enqueues a plain pending tx (no syncId, no delete) for resend", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();

    await adapter.cacheTransaction({
      action: "U",
      modelId: "t1",
      modelName: "TestTask",
      changes: { title: { oldValue: "A", newValue: "B" } },
    });

    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const sender = vi
      .fn()
      .mockResolvedValue({ success: true, lastSyncId: 99 });
    queue.setSender(sender);

    const count = await queue.resendCached();
    expect(count).toBe(1);
    expect(queue.pendingCount).toBe(1);

    // Drive the flush so we observe the tx actually being sent.
    await new Promise((r) => setTimeout(r, 60));
    expect(sender).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(0);
    // Now in awaitingSync, with the cache record updated to flag it.
    expect(queue.awaitingSyncCount).toBe(1);
    const tx = (queue as unknown as { awaitingSync: { state: TransactionState }[] })
      .awaitingSync[0];
    expect(tx.state).toBe(TransactionState.CompletedButUnsynced);
  });
});
