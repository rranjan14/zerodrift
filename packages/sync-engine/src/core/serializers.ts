export const dateSerializer = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : value;

export const dateDeserializer = (raw: unknown): unknown =>
  typeof raw === "string" ? new Date(raw) : raw;
