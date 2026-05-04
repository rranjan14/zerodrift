/**
 * Abstract base classes with decorated properties.
 *
 * Property/action/computed decorators stash their metadata in a per-class
 * side-table (WeakMap), not the ModelRegistry. @ClientModel drains the
 * stash for the concrete class plus every ancestor up the prototype chain.
 *
 * Net result:
 *   - The abstract base is never registered as a model.
 *   - The concrete subclass's registry entry contains the union of its own
 *     decorators and every ancestor's.
 *   - Multiple subclasses sharing the same abstract base each inherit
 *     independently — the abstract's pending entry is read-only after drain.
 */

import { describe, it, expect } from "vitest";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { TestSharedSubclassA, TestSharedSubclassB } from "./fixtures";

describe("ModelRegistry — abstract base inheritance", () => {
  it("does not register the abstract base as a model", () => {
    expect(ModelRegistry.getModelMeta("TestAbstractBase")).toBeUndefined();
    const names = ModelRegistry.allModels().map((m) => m.name);
    expect(names).not.toContain("TestAbstractBase");
  });

  it("merges abstract-base property metadata into the concrete subclass", () => {
    const meta = ModelRegistry.getModelMeta("TestSharedSubclassA");
    expect(meta).toBeDefined();
    const propNames = [...meta!.properties.keys()].sort();
    // sharedTitle + sharedTaskId from TestAbstractBase, extraA from TestSharedSubclassA
    expect(propNames).toEqual(["extraA", "sharedTaskId", "sharedTitle"]);
  });

  it("lets sibling subclasses each inherit the abstract's decorations independently", () => {
    const a = ModelRegistry.getModelMeta("TestSharedSubclassA");
    const b = ModelRegistry.getModelMeta("TestSharedSubclassB");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Both see sharedTitle / sharedTaskId from the abstract base.
    expect(a!.properties.has("sharedTitle")).toBe(true);
    expect(b!.properties.has("sharedTitle")).toBe(true);
    expect(a!.properties.has("sharedTaskId")).toBe(true);
    expect(b!.properties.has("sharedTaskId")).toBe(true);

    // Each only carries its own subclass-specific decoration.
    expect(a!.properties.has("extraA")).toBe(true);
    expect(a!.properties.has("extraB")).toBe(false);
    expect(b!.properties.has("extraB")).toBe(true);
    expect(b!.properties.has("extraA")).toBe(false);
  });

  it("preserves indexed metadata from abstract-base properties", () => {
    const meta = ModelRegistry.getModelMeta("TestSharedSubclassA");
    expect(meta!.properties.get("sharedTaskId")?.indexed).toBe(true);
    expect(meta!.properties.get("sharedTitle")?.indexed).toBeFalsy();
  });

  it("hydrates and reads abstract-base properties on a concrete instance", () => {
    const m = new TestSharedSubclassA();
    m.hydrate({ id: "x", sharedTitle: "hello", sharedTaskId: "t1", extraA: 7 });
    m.makeModelObservable();
    expect(m.sharedTitle).toBe("hello");
    expect(m.sharedTaskId).toBe("t1");
    expect(m.extraA).toBe(7);
  });

  it("propagates writes to abstract-base properties through the change-tracking path", () => {
    const m = new TestSharedSubclassB();
    m.hydrate({ id: "y", sharedTitle: "x", sharedTaskId: "t2", extraB: true });
    m.makeModelObservable();
    m.sharedTitle = "updated";
    expect(m.sharedTitle).toBe("updated");
    expect(m.hasUnsavedChanges).toBe(true);
  });
});
