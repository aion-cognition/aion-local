import { z } from 'zod';

import { type KNOBS, KNOB_TABLE } from './knobs.js';

type Table = typeof KNOBS;

/** Pulls a row's zod schema out of the tuple, which is where the leaf's type comes from. */
type SchemaOf<Row> = Row extends readonly [string, infer Schema extends z.ZodType, ...unknown[]]
  ? Schema
  : never;

/**
 * The nested shape every consumer reads, cut from the same table the validator is folded out of.
 * A leaf's type is whatever its own zod schema produces, so a knob cannot be typed one way and
 * validated another. The modifiers come off because the table is declared `as const` and a
 * config object is written to during loading.
 */
export type Config = {
  -readonly [G in keyof Table]: {
    -readonly [L in keyof Table[G]]: z.infer<SchemaOf<Table[G][L]>>;
  };
};

function configShape(): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [group, leaves] of Object.entries(KNOB_TABLE)) {
    const groupShape: Record<string, z.ZodType> = {};
    for (const [leaf, [, schema]] of Object.entries(leaves)) {
      groupShape[leaf] = schema;
    }
    shape[group] = z.object(groupShape);
  }
  return shape;
}

/**
 * A tree folded at runtime cannot carry its own nested type, so the built schema is named with
 * the type the same table produces at compile time. The two agree by construction: both walk
 * the one table, and each leaf contributes the same zod schema to each.
 */
export const ConfigSchema = z.object(configShape()) as unknown as z.ZodType<Config>;
