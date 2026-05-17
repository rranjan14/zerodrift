/**
 * Compound index-key collapse (Phase C — server-side compound-key parity
 * with Linear's transient partial-index keys).
 *
 * `wrapCompoundFetcher` inspects each batched fetch and replaces N
 * per-parent queries with one server-side compound query whenever
 * ≥ COMPOUND_FETCH_THRESHOLD requests share a parent FK value.
 * Adopters opt in via `serverSupportsCompoundIndexKeys: true` so backends
 * without JOIN support keep per-parent fan-out.
 *
 * `BatchModelLoader.flush` already filters each waiter's bag by direct FK
 * (`record["issueId"] === Ix`), so callers see exactly their slice even
 * when the response is a compound superset.
 */

import { describe, it, expect, vi } from "vitest";
import { ObjectPool } from "@zerodrift/ObjectPool";
import {
  collapseQueries,
  wrapCompoundFetcher,
  COMPOUND_FETCH_THRESHOLD,
} from "@zerodrift/CompoundIndexFetcher";
// Side-effect import: registers the fixture model classes (TestTask,
// TestProject, TestUser, TestComment, TestActivity) with ModelRegistry so
// the rewrite walks see their FK metadata.
import "./fixtures";
import { TestTask } from "./fixtures";

function makeTask(id: string, projectId: string, assigneeId = ""): TestTask {
  const t = new TestTask();
  t.hydrate({ id, projectId, assigneeId });
  t.makeModelObservable();
  return t;
}

describe("collapseQueries", () => {
  it("returns input unchanged when below the collapse threshold", () => {
    const pool = new ObjectPool();
    const queries = Array.from({ length: COMPOUND_FETCH_THRESHOLD - 1 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));
    expect(collapseQueries(queries, pool)).toEqual(queries);
  });

  it("collapses when ≥ threshold queries share the parent's FK value", () => {
    const pool = new ObjectPool();
    // 6 tasks, all in project P1 → Comment[taskId.projectId=P1] covers them.
    for (let i = 0; i < 6; i++) {
      pool.put("TestTask", makeTask(`t${i}`, "P1"));
    }
    const queries = Array.from({ length: 6 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));

    const collapsed = collapseQueries(queries, pool);
    expect(collapsed).toEqual([
      { modelName: "TestComment", indexKey: "taskId.projectId", value: "P1" },
    ]);
  });

  it("keeps non-sharing stragglers as direct queries alongside the compound", () => {
    const pool = new ObjectPool();
    // 5 tasks in P1, 2 in P2. Threshold-5 group collapses; the 2 stay direct.
    for (let i = 0; i < 5; i++) {
      pool.put("TestTask", makeTask(`p1-${i}`, "P1"));
    }
    pool.put("TestTask", makeTask("p2-0", "P2"));
    pool.put("TestTask", makeTask("p2-1", "P2"));

    const queries = [
      ...Array.from({ length: 5 }, (_, i) => ({
        modelName: "TestComment" as const,
        indexKey: "taskId",
        value: `p1-${i}`,
      })),
      { modelName: "TestComment", indexKey: "taskId", value: "p2-0" },
      { modelName: "TestComment", indexKey: "taskId", value: "p2-1" },
    ];

    const collapsed = collapseQueries(queries, pool);
    // One compound query for the P1 group + 2 direct queries for the P2 stragglers.
    expect(collapsed).toContainEqual({
      modelName: "TestComment",
      indexKey: "taskId.projectId",
      value: "P1",
    });
    expect(collapsed).toContainEqual({
      modelName: "TestComment",
      indexKey: "taskId",
      value: "p2-0",
    });
    expect(collapsed).toContainEqual({
      modelName: "TestComment",
      indexKey: "taskId",
      value: "p2-1",
    });
    expect(collapsed).toHaveLength(3);
  });

  it("picks the largest sharing axis when parents share multiple FKs", () => {
    const pool = new ObjectPool();
    // 6 tasks: all in project P1; 5 of them assigned to user U1, 1 to U2.
    // The projectId axis (6) wins over assigneeId (5) — single compound.
    for (let i = 0; i < 5; i++) {
      pool.put("TestTask", makeTask(`t${i}`, "P1", "U1"));
    }
    pool.put("TestTask", makeTask("t5", "P1", "U2"));

    const queries = Array.from({ length: 6 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));

    const collapsed = collapseQueries(queries, pool);
    expect(collapsed).toEqual([
      { modelName: "TestComment", indexKey: "taskId.projectId", value: "P1" },
    ]);
  });

  it("falls back to direct fan-out when parents aren't in the pool", () => {
    const pool = new ObjectPool();
    // 6 queries but no task in pool — can't read FKs to find sharing.
    const queries = Array.from({ length: 6 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));

    expect(collapseQueries(queries, pool)).toEqual(queries);
  });

  it("does not cross (modelName, indexKey) boundaries", () => {
    const pool = new ObjectPool();
    // 5 Comment[taskId=...] + 5 Activity[taskId=...] — different model.
    // Even with ≥ threshold per-side, each group is independent.
    for (let i = 0; i < 5; i++) {
      pool.put("TestTask", makeTask(`t${i}`, "P1"));
    }
    const queries = [
      ...Array.from({ length: 5 }, (_, i) => ({
        modelName: "TestComment",
        indexKey: "taskId",
        value: `t${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        modelName: "TestActivity",
        indexKey: "taskId",
        value: `t${i}`,
      })),
    ];

    const collapsed = collapseQueries(queries, pool);
    // Two compound queries, one per modelName.
    expect(collapsed).toContainEqual({
      modelName: "TestComment",
      indexKey: "taskId.projectId",
      value: "P1",
    });
    expect(collapsed).toContainEqual({
      modelName: "TestActivity",
      indexKey: "taskId.projectId",
      value: "P1",
    });
    expect(collapsed).toHaveLength(2);
  });

  it("avoids over-eager compound when only some queries share an FK", () => {
    const pool = new ObjectPool();
    // 4 share P1, 4 share P2 — neither side meets threshold-5. Stay direct.
    for (let i = 0; i < 4; i++) {
      pool.put("TestTask", makeTask(`a${i}`, "P1"));
    }
    for (let i = 0; i < 4; i++) {
      pool.put("TestTask", makeTask(`b${i}`, "P2"));
    }
    const queries = [
      ...Array.from({ length: 4 }, (_, i) => ({
        modelName: "TestComment",
        indexKey: "taskId",
        value: `a${i}`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        modelName: "TestComment",
        indexKey: "taskId",
        value: `b${i}`,
      })),
    ];

    expect(collapseQueries(queries, pool)).toEqual(queries);
  });

  it("ignores parent FKs whose value is null", () => {
    const pool = new ObjectPool();
    // 6 tasks in project P1, but assigneeId is null on all — only projectId wins.
    for (let i = 0; i < 6; i++) {
      pool.put("TestTask", makeTask(`t${i}`, "P1"));
    }
    const queries = Array.from({ length: 6 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));

    const collapsed = collapseQueries(queries, pool);
    expect(collapsed).toEqual([
      { modelName: "TestComment", indexKey: "taskId.projectId", value: "P1" },
    ]);
  });
});

describe("wrapCompoundFetcher", () => {
  it("invokes the inner fetcher with the rewritten query set", async () => {
    const pool = new ObjectPool();
    for (let i = 0; i < 5; i++) {
      pool.put("TestTask", makeTask(`t${i}`, "P1"));
    }

    const inner = vi.fn().mockResolvedValue({});
    const wrapped = wrapCompoundFetcher(inner, pool);

    const queries = Array.from({ length: 5 }, (_, i) => ({
      modelName: "TestComment",
      indexKey: "taskId",
      value: `t${i}`,
    }));
    await wrapped(queries);

    expect(inner).toHaveBeenCalledWith([
      { modelName: "TestComment", indexKey: "taskId.projectId", value: "P1" },
    ]);
  });

  it("forwards untouched queries when no collapse opportunity", async () => {
    const pool = new ObjectPool();
    const inner = vi.fn().mockResolvedValue({});
    const wrapped = wrapCompoundFetcher(inner, pool);

    const queries = [
      { modelName: "TestComment", indexKey: "taskId", value: "t1" },
      { modelName: "TestComment", indexKey: "taskId", value: "t2" },
    ];
    await wrapped(queries);
    expect(inner).toHaveBeenCalledWith(queries);
  });
});
