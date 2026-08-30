import neo4j from 'neo4j-driver';

import type { Vector } from '../providers/types.js';

/**
 * Values this adapter is willing to send to Neo4j. `undefined` is dropped rather than
 * written: Cypher has no null property, so setting one removes the property, and the
 * bitemporal read modes rely on "open" meaning "property absent" (`valid_until IS NULL`).
 */
export type GraphWritable =
  string | number | boolean | Date | readonly string[] | readonly number[] | readonly boolean[];

export type GraphProperties = Record<string, GraphWritable | undefined>;

export type Row = Record<string, unknown>;

export type RowMapper<T> = (row: Row) => T;

/**
 * Embeddings go to the server as a plain list of floats, not the driver's native Vector.
 * The Community image's aligned store format rejects vector-typed properties outright
 * ("storing properties of type vector is not supported in aligned store format"), and the
 * block format that would accept them fails to start on Community. A float list is what
 * the vector index actually indexes; an exact-match query against it scores 1.0.
 */
export function toGraphVector(vector: Vector): number[] {
  return Array.from(vector);
}

/** Procedure arguments and `LIMIT` are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
export function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export function fromGraphVector(value: unknown): number[] | undefined {
  const coerced = coerceGraphValue(value);
  if (!Array.isArray(coerced)) {
    return undefined;
  }
  return coerced.every((entry) => typeof entry === 'number') ? coerced : undefined;
}

/** A JS Date is rejected as a query parameter; the driver's DateTime is the only accepted form. */
export function toGraphDateTime(value: Date): unknown {
  return neo4j.types.DateTime.fromStandardDate(value);
}

export function fromGraphDateTime(value: unknown): Date | undefined {
  const coerced = coerceGraphValue(value);
  return coerced instanceof Date ? coerced : undefined;
}

/**
 * `Array.isArray` narrows to `any[]` in lib.es5 regardless of the input union, so a spread
 * behind that guard reads as spreading `any`. This restates the same runtime check with the
 * honest element type, which is what a `GraphWritable` array actually holds.
 */
function isGraphWritableArray(
  value: GraphWritable,
): value is readonly string[] | readonly number[] | readonly boolean[] {
  return Array.isArray(value);
}

function toGraphValue(value: GraphWritable): unknown {
  if (value instanceof Date) {
    return toGraphDateTime(value);
  }
  if (isGraphWritableArray(value)) {
    return [...value];
  }
  return value;
}

export function toGraphParameters(properties: GraphProperties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      out[key] = toGraphValue(value);
    }
  }
  return out;
}

/**
 * Driver-native values (lossless Integer, DateTime, Node, Relationship) become plain JS
 * so no caller outside this directory has to know the driver's type system. Recursive,
 * because these arrive nested inside maps and lists returned by pattern comprehensions.
 */
export function coerceGraphValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isDate(value)) {
    return value.toStandardDate();
  }
  if (neo4j.isVector(value)) {
    return Array.from(value.asTypedArray(), Number);
  }
  if (neo4j.isNode(value)) {
    return {
      elementId: value.elementId,
      labels: [...value.labels],
      properties: coerceGraphValue(value.properties),
    };
  }
  if (neo4j.isRelationship(value)) {
    return {
      elementId: value.elementId,
      type: value.type,
      properties: coerceGraphValue(value.properties),
    };
  }
  if (Array.isArray(value)) {
    return value.map(coerceGraphValue);
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = coerceGraphValue(entry);
    }
    return out;
  }
  return value;
}

export function coerceRow(row: Row): Row {
  return coerceGraphValue(row) as Row;
}

/** Every read helper's default mapper: the record as plain JS, driver types already unwrapped. */
export const identityRow: RowMapper<Row> = (row) => row;
