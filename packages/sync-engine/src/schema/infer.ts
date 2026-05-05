import type { EntityDef, FieldBuilder, FieldMeta, SchemaDef } from "./types";

export type FieldType<F> = F extends FieldBuilder<infer T, FieldMeta>
  ? T
  : never;

export type FieldIsNullable<F> = null extends FieldType<F> ? true : false;

/** Extract the refId target literal, e.g. `"team"` from `s.refId("team")`. */
export type FieldRefTarget<F> = F extends FieldBuilder<unknown, infer M>
  ? M extends { kind: "refId"; refTarget: infer T extends string }
    ? T
    : never
  : never;

export type EntityKey<S extends SchemaDef> = keyof S["entities"] & string;

export type EntityFieldsRecord<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = S["entities"][K] extends EntityDef<infer F> ? F : never;

/**
 * Stub shape for the reactive lazy-collection wrapper that today's
 * `RefCollection` / `BackRef` runtime classes return. The schema-typed
 * record can't extend `BaseModel` without coupling the type wall the
 * proxy is meant to abstract, so we expose a narrow interface here and
 * project `RefCollection` onto it when the typed client lands (Phase 3).
 */
export interface RelationCollection<T> {
  load(): Promise<readonly T[]>;
  readonly items: readonly T[];
}

type EntityFieldTypes<S extends SchemaDef, K extends EntityKey<S>> = {
  [P in keyof EntityFieldsRecord<S, K>]: FieldType<EntityFieldsRecord<S, K>[P]>;
};

type SingularRelationKey<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  from: { entity: K; as: infer A extends string };
}
  ? A
  : never;

type SingularRelationValue<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  from: { entity: K; field: infer FFK };
  to: { entity: infer TE extends string };
}
  ? TE extends EntityKey<S>
    ? FFK extends keyof EntityFieldsRecord<S, K>
      ? FieldIsNullable<EntityFieldsRecord<S, K>[FFK]> extends true
        ? InferEntity<S, TE> | null
        : InferEntity<S, TE>
      : never
    : never
  : never;

type SingularRelations<S extends SchemaDef, K extends EntityKey<S>> = {
  [LK in keyof S["links"] as SingularRelationKey<
    S,
    K,
    LK
  >]: SingularRelationValue<S, K, LK>;
};

type ReverseCollectionKey<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  to: { entity: K; many: infer M extends string };
}
  ? M
  : never;

type ReverseCollectionValue<
  S extends SchemaDef,
  LK extends keyof S["links"],
> = S["links"][LK] extends { from: { entity: infer FE extends string } }
  ? FE extends EntityKey<S>
    ? RelationCollection<InferEntity<S, FE>>
    : never
  : never;

type ReverseCollections<S extends SchemaDef, K extends EntityKey<S>> = {
  [LK in keyof S["links"] as ReverseCollectionKey<
    S,
    K,
    LK
  >]: ReverseCollectionValue<S, LK>;
};

/**
 * The record shape for a schema entity: declared fields, plus singular
 * relation properties for every link that originates on this entity, plus
 * reverse-collection properties for every link that targets it.
 *
 * Does not include extension members (computed / actions) — those are layered
 * in by `InferRecord` once `extend(...)` lands.
 *
 * Returned as a plain intersection — wrapping in a `Prettify` mapped type
 * would force TS to materialize a fresh object per relation step every time
 * `InferEntity` recurses through a link. Users can pretty their own aliases
 * with a one-line helper at the call site if they want.
 */
export type InferEntity<S extends SchemaDef, K extends EntityKey<S>> =
  EntityFieldTypes<S, K> & SingularRelations<S, K> & ReverseCollections<S, K>;

export type InferCreateInput<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = EntityFieldTypes<S, K>;

export type InferUpdateInput<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = Partial<EntityFieldTypes<S, K>>;
