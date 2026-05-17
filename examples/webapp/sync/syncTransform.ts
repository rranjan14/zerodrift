import type { SyncAction, SyncMessageTransform } from "zerodrift";

/**
 * Protocol adapter for SSE messages — the same role `fetchers.ts` plays for
 * the bootstrap/transaction endpoints.
 *
 * The reference Go backend streams one flat changelog row per SSE message:
 *
 *   { id, modelName, modelId, action, data?, syncGroups[], createdAt }
 *
 * The engine expects the canonical batched `DeltaPacket`
 * (`{ syncId, syncActions: [...] , addedSyncGroups?, removedSyncGroups? }`).
 * `syncTransform` is the documented hook for exactly this envelope gap;
 * return `null` to drop a message the engine shouldn't process.
 */
interface ChangelogEntry {
  id?: number;
  modelName?: string;
  modelId?: string;
  action?: string;
  data?: unknown;
  syncGroups?: string[];
}

export const syncTransform: SyncMessageTransform = (raw) => {
  const e = raw as ChangelogEntry;
  if (
    e == null ||
    typeof e.modelName !== "string" ||
    typeof e.modelId !== "string" ||
    typeof e.action !== "string"
  ) {
    // Not a changelog row (keepalive / unexpected) — drop it.
    return null;
  }
  return {
    syncId: typeof e.id === "number" ? e.id : 0,
    syncActions: [
      {
        modelName: e.modelName,
        modelId: e.modelId,
        action: e.action as SyncAction["action"],
        data:
          e.data == null ? undefined : (e.data as Record<string, unknown>),
      },
    ],
    addedSyncGroups: [],
    removedSyncGroups: [],
  };
};
