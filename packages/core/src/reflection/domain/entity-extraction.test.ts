import { describe, expect, it } from 'vitest';

import {
  ENTITY_EXTRACTION_JSON_SCHEMA,
  ENTITY_TYPES,
  entityContentText,
  isEntityType,
  normalizeEntityName,
  parseExtractedEntities,
  type ExtractedEntity,
} from './entity-extraction.js';
import { normalizeSeedName } from '../../infrastructure/graph/seed-queries.js';

const MAX = 32;

function entity(
  name: string,
  type = 'person',
  context = '',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, type, context, ...extra };
}

describe('normalizeEntityName', () => {
  it('folds case and collapses inner whitespace', () => {
    expect(normalizeEntityName('  Alice   CHEN ')).toBe('alice chen');
  });

  it('agrees with the fold the graph adapter resolves names by', () => {
    for (const name of ['Alice Chen', '  ALICE   chen  ', 'aion', 'Ryan\tHuber']) {
      expect(normalizeEntityName(name)).toBe(normalizeSeedName(name));
    }
  });
});

describe('parseExtractedEntities', () => {
  it('rejects a payload that is not an extraction so the caller can refine it', () => {
    expect(parseExtractedEntities({ things: [] }, MAX)).toBeUndefined();
    expect(parseExtractedEntities('entities: alice', MAX)).toBeUndefined();
    expect(parseExtractedEntities({ entities: [{ label: 'alice' }] }, MAX)).toBeUndefined();
  });

  it('accepts an empty extraction, which is a real answer about an episode that names nothing', () => {
    expect(parseExtractedEntities({ entities: [] }, MAX)).toEqual([]);
  });

  it('keeps one node per name identity, whatever case the model returned', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('Alice Chen'), entity('alice chen'), entity('ALICE CHEN')] },
      MAX,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({
      name: 'Alice Chen',
      nameNorm: 'alice chen',
      type: 'person',
    });
  });

  it('merges one name typed two ways into one identity and records both typings', () => {
    const parsed = parseExtractedEntities(
      {
        entities: [
          entity('Aion', 'project', 'the memory substrate'),
          entity('Aion', 'tool', 'the command a session runs'),
          entity('aion', 'project', 'the memory substrate'),
        ],
      },
      MAX,
    );

    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({ name: 'Aion', nameNorm: 'aion', type: 'project' });
    expect(parsed?.[0]?.types).toEqual(['project', 'tool']);
    expect(parsed?.[0]?.context).toBe('the memory substrate; the command a session runs');
  });

  it('files an off-taxonomy type under a known one rather than dropping a named entity', () => {
    const parsed = parseExtractedEntities({ entities: [entity('Postgres', 'technology')] }, MAX);
    expect(parsed?.[0]).toMatchObject({ name: 'Postgres', type: 'topic' });
  });

  it('parses an entity that omitted its context', () => {
    const parsed = parseExtractedEntities({ entities: [{ name: 'Aion', type: 'project' }] }, MAX);
    expect(parsed?.[0]).toMatchObject({
      name: 'Aion',
      type: 'project',
      types: ['project'],
      context: '',
      aliases: [],
      isSpeaker: false,
    });
  });

  it('drops an empty name and a name long enough to be a sentence', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('   '), entity('a'.repeat(200)), entity('Aion', 'project')] },
      MAX,
    );
    expect(parsed?.map((row) => row.name)).toEqual(['Aion']);
  });

  it('stops at the cap instead of writing whatever a runaway model returned', () => {
    const entities = Array.from({ length: 50 }, (_unused, index) => entity(`Person ${index}`));
    expect(parseExtractedEntities({ entities }, 5)).toHaveLength(5);
  });
});

describe('aliases', () => {
  it('folds every alias the way the primary name is folded', () => {
    const parsed = parseExtractedEntities(
      {
        entities: [entity('Aion', 'project', '', { aliases: ['  AION   Project ', 'Ａion ＤB'] })],
      },
      MAX,
    );
    expect(parsed?.[0]?.aliases).toEqual(['aion project', 'aion db']);
  });

  it('drops an alias that folds to the entity own name, which is not a second name for it', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('Alice Chen', 'person', '', { aliases: ['ALICE CHEN', 'Chen'] })] },
      MAX,
    );
    expect(parsed?.[0]?.aliases).toEqual(['chen']);
  });

  it('caps the list, so a model that lists every mention cannot fill the node', () => {
    const aliases = Array.from({ length: 20 }, (_unused, index) => `alias ${index}`);
    const parsed = parseExtractedEntities(
      { entities: [entity('Aion', 'project', '', { aliases })] },
      MAX,
    );
    expect(parsed?.[0]?.aliases).toEqual(aliases.slice(0, 8));
  });

  it('ignores an aliases field that is not a list of usable names', () => {
    const parsed = parseExtractedEntities(
      {
        entities: [
          entity('Aion', 'project', '', { aliases: 'aion project' }),
          entity('Valkey', 'tool', '', { aliases: [17, '  ', 'a'.repeat(200), 'Valkey Server'] }),
        ],
      },
      MAX,
    );
    expect(parsed?.[0]?.aliases).toEqual([]);
    expect(parsed?.[1]?.aliases).toEqual(['valkey server']);
  });

  it('unions the aliases of two extractions of one name', () => {
    const parsed = parseExtractedEntities(
      {
        entities: [
          entity('Aion', 'project', '', { aliases: ['aion project'] }),
          entity('aion', 'tool', '', { aliases: ['aion project', 'the substrate'] }),
        ],
      },
      MAX,
    );
    expect(parsed?.[0]?.aliases).toEqual(['aion project', 'the substrate']);
  });
});

describe('is_speaker', () => {
  it('is false unless the model said otherwise', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('Aion'), entity('Ryan', 'person', '', { is_speaker: 'yes' })] },
      MAX,
    );
    expect(parsed?.map((row) => row.isSpeaker)).toEqual([false, false]);
  });

  it('carries a speaker flag from either extraction of one name', () => {
    const parsed = parseExtractedEntities(
      {
        entities: [
          entity('Ryan Huber', 'person', 'the member'),
          entity('ryan huber', 'person', 'the one speaking', { is_speaker: true }),
        ],
      },
      MAX,
    );
    expect(parsed?.[0]?.isSpeaker).toBe(true);
  });
});

describe('entityContentText', () => {
  const base: ExtractedEntity = {
    name: 'Aion',
    nameNorm: 'aion',
    type: 'project',
    types: ['project'],
    context: '',
    aliases: [],
    isSpeaker: false,
  };

  it('names the entity and its type when the model gave no context', () => {
    expect(entityContentText(base)).toBe('Aion (project)');
  });

  it('appends the context the episode gave it', () => {
    expect(entityContentText({ ...base, context: 'the memory substrate under build' })).toBe(
      'Aion (project): the memory substrate under build',
    );
  });
});

type SchemaField = { type: string; enum?: string[]; items?: { type: string } };

type SchemaShape = {
  properties: {
    entities: {
      items: {
        properties: { type: SchemaField; aliases: SchemaField; is_speaker: SchemaField };
        required: string[];
      };
    };
  };
};

const schemaItem = (ENTITY_EXTRACTION_JSON_SCHEMA as unknown as SchemaShape).properties.entities
  .items;

describe('the taxonomy', () => {
  it('is the same list the structured-output schema constrains the model to', () => {
    expect(schemaItem.properties.type.enum).toEqual([...ENTITY_TYPES]);
  });

  it('recognises exactly its own members', () => {
    expect(ENTITY_TYPES.every((type) => isEntityType(type))).toBe(true);
    expect(isEntityType('technology')).toBe(false);
  });

  it('says topic, not concept, which is the name of a fact label', () => {
    expect(isEntityType('topic')).toBe(true);
    expect(isEntityType('concept')).toBe(false);
  });
});

describe('the structured-output schema', () => {
  it('asks for aliases and a speaker flag, and requires neither', () => {
    expect(schemaItem.properties.aliases).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schemaItem.properties.is_speaker).toEqual({ type: 'boolean' });
    expect(schemaItem.required).toEqual(['name', 'type', 'context']);
  });

  it('asks the model for no confidence anywhere', () => {
    expect(JSON.stringify(ENTITY_EXTRACTION_JSON_SCHEMA)).not.toContain('confidence');
  });
});
