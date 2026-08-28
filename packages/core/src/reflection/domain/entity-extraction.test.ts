import { describe, expect, it } from 'vitest';
import { normalizeSeedName } from '../../infrastructure/graph/seed-queries.js';
import {
  ENTITY_EXTRACTION_JSON_SCHEMA,
  ENTITY_TYPES,
  entityContentText,
  isEntityType,
  normalizeEntityName,
  parseExtractedEntities,
  type ExtractedEntity,
} from './entity-extraction.js';

const MAX = 32;

function entity(name: string, type = 'person', context = ''): Record<string, unknown> {
  return { name, type, context };
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

  it('keeps one node per (name, type) identity, whatever case the model returned', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('Alice Chen'), entity('alice chen'), entity('ALICE CHEN')] },
      MAX,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({ name: 'Alice Chen', nameNorm: 'alice chen', type: 'person' });
  });

  it('keeps one name under two types apart, since the graph keys identity on the pair', () => {
    const parsed = parseExtractedEntities(
      { entities: [entity('Aion', 'project'), entity('Aion', 'tool')] },
      MAX,
    );
    expect(parsed?.map((row) => row.type)).toEqual(['project', 'tool']);
  });

  it('files an off-taxonomy type under a known one rather than dropping a named entity', () => {
    const parsed = parseExtractedEntities({ entities: [entity('Postgres', 'technology')] }, MAX);
    expect(parsed?.[0]).toMatchObject({ name: 'Postgres', type: 'concept' });
  });

  it('parses an entity that omitted its context', () => {
    const parsed = parseExtractedEntities({ entities: [{ name: 'Aion', type: 'project' }] }, MAX);
    expect(parsed?.[0]).toMatchObject({ name: 'Aion', type: 'project', context: '' });
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

describe('entityContentText', () => {
  const base: ExtractedEntity = { name: 'Aion', nameNorm: 'aion', type: 'project', context: '' };

  it('names the entity and its type when the model gave no context', () => {
    expect(entityContentText(base)).toBe('Aion (project)');
  });

  it('appends the context the episode gave it', () => {
    expect(entityContentText({ ...base, context: 'the memory substrate under build' })).toBe(
      'Aion (project): the memory substrate under build',
    );
  });
});

describe('the taxonomy', () => {
  it('is the same list the structured-output schema constrains the model to', () => {
    const schema = ENTITY_EXTRACTION_JSON_SCHEMA as unknown as {
      properties: { entities: { items: { properties: { type: { enum: string[] } } } } };
    };
    expect(schema.properties.entities.items.properties.type.enum).toEqual([...ENTITY_TYPES]);
  });

  it('recognises exactly its own members', () => {
    expect(ENTITY_TYPES.every((type) => isEntityType(type))).toBe(true);
    expect(isEntityType('technology')).toBe(false);
  });
});
