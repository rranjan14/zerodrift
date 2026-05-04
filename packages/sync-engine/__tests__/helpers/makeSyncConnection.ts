import {
  SyncConnection,
  type SyncConnectionOptions,
} from "@sync-engine/SyncConnection";
import type { StorageAdapter } from "@sync-engine/Database";
import type { ObjectPool } from "@sync-engine/ObjectPool";
import type { TransactionQueue } from "@sync-engine/TransactionQueue";

interface MakeSyncConnectionOptions extends SyncConnectionOptions {
  url?: string;
  db: StorageAdapter;
  pool: ObjectPool;
  queue: TransactionQueue;
}

export function makeSyncConnection(
  opts: MakeSyncConnectionOptions,
): SyncConnection {
  const { url, db, pool, queue, ...rest } = opts;
  return new SyncConnection(
    url ?? "http://localhost/events",
    db,
    pool,
    queue,
    rest,
  );
}
