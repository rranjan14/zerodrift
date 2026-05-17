/**
 * Auto-derived covering indexes (Phase A — purely client-side parity work
 * with Linear's transient partial-index keys).
 *
 * The registry walks the parent's outgoing FK chain up to `transientIndexDepth`
 * hops; at each level it intersects with the child's indexed properties.
 * Each match becomes a `CoveringPath` resolved at `RefCollection.hydrate()`:
 * depth-1 paths read directly from the parent, deeper paths walk the pool.
 *
 * Manual `coveringIndexes` decorator option still wins for axes that aren't
 * auto-detectable (or that the adopter wants to scope back).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelRegistry } from "@zerodrift/ModelRegistry";
import { BaseModel } from "@zerodrift/BaseModel";
// `setup.ts` already imports `./fixtures` for side effects, so every fixture
// (including `TestDenormChild` / `TestDenormGreatParent`) is registered in the
// ModelRegistry before any test runs — the named imports here are just for
// the constructor references used in the hydrate tests.
import { TestDenormParent, TestDenormGrandparent } from "./fixtures";

// Match the cleanup pattern used in PartialIndexStore / DeferredModels tests.
// `parent.makeModelObservable()` reads `BaseModel.storeManager?.transientIndexDepth`,
// so we want a known-null state both before and after each case.
beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(() => {
  BaseModel.storeManager = null;
});

describe("ModelRegistry.getDerivedCoveringPaths", () => {
  it("finds depth-1 axes — parent's direct FKs that match the child's indexed props", () => {
    const paths = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormParent",
      "TestDenormChild",
      1,
    );
    // TestDenormParent has FK `grandparentId`; child has `grandparentId` indexed.
    expect(paths).toEqual([
      {
        axis: "grandparentId",
        hops: [{ fk: "grandparentId", throughModel: "TestDenormGrandparent" }],
      },
    ]);
  });

  it("walks deeper at depth 2 to catch denormalization through an intermediate FK", () => {
    const paths = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormParent",
      "TestDenormChild",
      2,
    );
    // depth 1: grandparentId (matched directly).
    // depth 2: walk parent → grandparent, find grandparent.greatId, child has
    //          indexed `greatId` → second auto-derived path.
    expect(paths).toContainEqual({
      axis: "grandparentId",
      hops: [{ fk: "grandparentId", throughModel: "TestDenormGrandparent" }],
    });
    expect(paths).toContainEqual({
      axis: "greatId",
      hops: [
        { fk: "grandparentId", throughModel: "TestDenormGrandparent" },
        { fk: "greatId", throughModel: "TestDenormGreatParent" },
      ],
    });
  });

  it("returns no paths for a child with no indexed-FK overlap", () => {
    // TestDenormGreatParent has no FKs; nothing to match.
    const paths = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormGreatParent",
      "TestDenormChild",
      3,
    );
    expect(paths).toEqual([]);
  });

  it("respects depth = 0 (no walk, no auto-derivation)", () => {
    const paths = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormParent",
      "TestDenormChild",
      0,
    );
    expect(paths).toEqual([]);
  });

  it("caches per (parent, child, depth) — same call returns the same array", () => {
    const a = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormParent",
      "TestDenormChild",
      3,
    );
    const b = ModelRegistry.getDerivedCoveringPaths(
      "TestDenormParent",
      "TestDenormChild",
      3,
    );
    expect(a).toBe(b);
  });
});

describe("RefCollection hydrate — auto-derived covering values", () => {
  it("merges manual coveringIndexes with auto-derived paths and dedupes", () => {
    const grandparent = new TestDenormGrandparent();
    grandparent.hydrate({ id: "g1", greatId: "great-x" });

    const parent = new TestDenormParent();
    parent.hydrate({ id: "p1", grandparentId: "g1" });

    // Both Instant — wire `store` so depth-2 resolution can walk through pool.
    // The collection is created during makeModelObservable; we just need the
    // pool side wired before that happens.
    parent.makeModelObservable();
    grandparent.makeModelObservable();

    const collection = parent.children;
    const queries = collection.getCoveringPartialIndexValues();

    // Direct FK first; auto-derived `grandparentId` second; depth-2 resolves
    // through grandparent → greatId.
    const keyValues = queries.map((q) => `${q.key}=${q.value}`);
    expect(keyValues).toContain("parentId=p1");
    expect(keyValues).toContain("grandparentId=g1");
    // greatId resolution requires the grandparent in the pool — see test below.
  });

  it("returns null silently when an intermediate model is missing from the pool", () => {
    // Parent in pool but grandparent never put — depth-2 path should skip
    // (no covering query emitted for the unresolvable path), not throw.
    const parent = new TestDenormParent();
    parent.hydrate({ id: "p2", grandparentId: "g-missing" });
    parent.makeModelObservable();

    const queries = parent.children
      .getCoveringPartialIndexValues()
      .map((q) => `${q.key}=${q.value}`);
    expect(queries).toContain("parentId=p2");
    expect(queries).toContain("grandparentId=g-missing");
    // No `greatId=...` — its resolution required the grandparent in pool.
    expect(queries.some((q) => q.startsWith("greatId="))).toBe(false);
  });
});
