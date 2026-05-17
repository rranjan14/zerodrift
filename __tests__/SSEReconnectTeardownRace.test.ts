import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "@zerodrift/Database";
import { ObjectPool } from "@zerodrift/ObjectPool";
import { TransactionQueue } from "@zerodrift/TransactionQueue";
import { BaseModel } from "@zerodrift/BaseModel";
import type { SSEClient } from "@zerodrift/SyncConnection";
import { controllableSSEClient } from "./helpers/sseClient";
import { makeSyncConnection } from "./helpers/makeSyncConnection";

// Regression coverage for the teardown ↔ reconnect race that surfaced as
// "Failed to execute 'transaction' on 'IDBDatabase': the database connection
// is closing". Two independent windows feed it:
//   1. disconnect() races a pending SSE onerror, which reschedules a reconnect
//      that then fires against an already-torn-down Database.
//   2. a cross-tab `versionchange` upgrade puts the connection into the
//      closing state — `this.db` is still non-null but `.transaction()` throws.

describe("SSE reconnect / Database teardown race", () => {
  let db: Database;
  let pool: ObjectPool;
  let queue: TransactionQueue;

  beforeEach(async () => {
    BaseModel.storeManager = null;
    db = new Database(crypto.randomUUID());
    await db.connect();
    // SyncConnection reads currentMeta; a baseline keeps it from bailing early.
    await db.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    pool = new ObjectPool();
    queue = new TransactionQueue(db, pool);
  });

  afterEach(async () => {
    BaseModel.storeManager = null;
    await db.destroy();
  });

  it("detaches onerror so a close()-emitted error cannot reopen after disconnect()", () => {
    vi.useFakeTimers();
    try {
      const factory = vi.fn(() => {
        const c = controllableSSEClient();
        // Pathological transport: closing the stream emits a final error
        // event. Pre-fix this re-entered scheduleReconnect() during teardown.
        const origClose = c.close;
        c.close = vi.fn(() => {
          origClose();
          c.onerror?.();
        });
        return c;
      });
      const conn = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: factory,
      });

      conn.connect();
      expect(factory).toHaveBeenCalledTimes(1);

      conn.disconnect();
      vi.advanceTimersByTime(5000);

      // close()'s trailing error must not have scheduled a reopen.
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire a reconnect scheduled before disconnect()", () => {
    vi.useFakeTimers();
    try {
      const clients: (SSEClient & { triggerError: () => void })[] = [];
      const factory = vi.fn(() => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      });
      const conn = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: factory,
      });

      conn.connect();
      clients[0].triggerError(); // network blip → 3s reconnect armed
      conn.disconnect(); // teardown wins the race
      vi.advanceTimersByTime(5000);

      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getCachedTransactions resolves to [] while the connection is closing", async () => {
    await withClosingConnection(db, async () => {
      await expect(db.getCachedTransactions()).resolves.toEqual([]);
      await expect(db.cacheTransaction({ a: 1 })).resolves.toBeNull();
    });
  });

  it("re-throws transaction failures that are not the closing state", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realDb = (db as any).db as IDBDatabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return () => {
            throw new Error("boom");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      await expect(db.getCachedTransactions()).rejects.toThrow("boom");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).db = realDb;
    }
  });
});

/**
 * Run `fn` with `db`'s handle swapped for one whose `.transaction()` throws
 * the closing-state `InvalidStateError` — the cross-tab `versionchange`
 * window — then restore the real handle so teardown still works.
 */
async function withClosingConnection(
  db: Database,
  fn: () => Promise<void>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realDb = (db as any).db as IDBDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return () => {
          const e = new Error(
            "Failed to execute 'transaction' on 'IDBDatabase': " +
              "the database connection is closing.",
          );
          e.name = "InvalidStateError";
          throw e;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db = realDb;
  }
}
