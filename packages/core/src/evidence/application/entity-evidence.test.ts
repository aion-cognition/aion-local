import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyEvidenceRevision } from './dependencies.js';
import type { SourceExcerpt } from './entity-excerpt-render.js';
import {
  assembleJudgmentEvidence,
  type JudgmentAssembly,
  type JudgmentPair,
  type JudgmentSide,
} from './judgment.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { DETECT_PROMPT } from '../../prompts/entity-merge-judge.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import { describeEntityMergePair } from '../../reflection/application/entity-merge-judge.js';
import { withEvidence } from '../../reflection/application/stages/entity-dedup-prompt.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import {
  admitRenderedInput,
  EVIDENCE_LIMITS,
  RequestBudget,
  renderableUnits,
} from '../domain/budget.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishNodeState,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

// An entity judgment never decodes a whole payload, so both whole-payload readers refuse in this
// file. Every case below passing is the proof that none of them needed one.
vi.mock('../../infrastructure/sqlite/experience-archive.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getExperienceById: (): never => {
    throw new Error('an entity judgment decoded a whole payload');
  },
  experiencePayloadBytes: (): never => {
    throw new Error('an entity judgment sized a whole payload');
  },
}));

const NOW = new Date('2026-09-20T12:00:00.000Z');
const LEFT = 'entity-aion-local';
const RIGHT = 'entity-aion-cognition';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let dir: string;
let store: SqliteStore;
let deps: { driver: Driver; db: SqliteStore['db'] };

function emptyDriver(): Driver {
  return { executeQuery: () => Promise.resolve({ records: [] }) } as unknown as Driver;
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** An entity whose node state and every role it is read through are counted. */
function entity(id: string): void {
  for (const role of ['mention', 'participation', 'stated_correction'] as const) {
    establishScope(store.db, id, durableRoleScope(role, 'in'), NOW);
  }
  establishNodeState(store.db, id, { revision: 1, at: NOW });
}

/** One accepted source, recorded against `nodes` in `role`. */
function capture(input: {
  readonly id: string;
  readonly minutesAgo: number;
  readonly nodes: readonly string[];
  readonly text?: string;
  readonly content?: ReflectionContent;
  readonly session?: string;
  readonly role?: string;
}): void {
  const content = input.content ?? {
    turns: [
      {
        role: 'user',
        text: input.text ?? `capture ${input.id}`,
        occurred_at: minutesAgo(input.minutesAgo),
      },
    ],
  };
  seedSource(store.db, {
    sourceId: input.id,
    sessionId: input.session ?? `session-${input.id}`,
    identity: 'agent',
    content,
    turnIds: (content.turns ?? []).map((_, index) => `${input.id}-turn-${String(index)}`),
    now: NOW,
  });
  for (const node of input.nodes) {
    commitIncidence(store.db, {
      sourceId: input.id,
      nodeId: node,
      role: input.role ?? 'mention',
      operationId: `link:${input.id}:${node}:${input.role ?? 'mention'}`,
      at: NOW,
    });
  }
}

function pair(overrides: Partial<JudgmentPair> = {}): JudgmentPair {
  return {
    route: 'entity_merge',
    reservedUnits: 0,
    use: 'entity_judgment',
    sides: [
      { nodeId: LEFT, statement: 'Aion Local', names: ['Aion Local', 'aion-local'] },
      { nodeId: RIGHT, statement: 'Aion Cognition', names: ['Aion Cognition'] },
    ],
    ...overrides,
  };
}

async function assemble(
  request: JudgmentPair = pair(),
  budget: RequestBudget = new RequestBudget(),
): Promise<JudgmentAssembly> {
  return assembleJudgmentEvidence(deps, request, checkedContext(), budget);
}

type Assembled = Extract<JudgmentAssembly, { status: 'assembled' }>;

function assembled(assembly: JudgmentAssembly): Assembled {
  if (assembly.status !== 'assembled') {
    throw new Error(`expected an assembled judgment, got ${JSON.stringify(assembly)}`);
  }
  return assembly;
}

function excerptsOf(side: JudgmentSide): readonly SourceExcerpt[] {
  if (side.evidence !== 'excerpts') {
    throw new Error('an entity side read whole sources');
  }
  return side.excerpts;
}

function renderedUnits(assembly: Assembled): number {
  return (
    assembly.sides[0].renderedUnits +
    assembly.sides[1].renderedUnits +
    (assembly.shared?.renderedUnits ?? 0)
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-entity-evidence-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  deps = { driver: emptyDriver(), db: store.db };
  entity(LEFT);
  entity(RIGHT);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the whole-payload readers in this file', () => {
  it('refuse a claim judgment, which still reads its sources whole', async () => {
    capture({ id: 'claim-source', minutesAgo: 1, nodes: [] });
    commitIncidence(store.db, {
      sourceId: 'claim-source',
      nodeId: 'claim',
      role: 'extraction',
      operationId: 'extract-claim',
      at: NOW,
    });
    establishScope(store.db, 'claim', durableRoleScope('extraction', 'out'), NOW);
    establishScope(store.db, 'claim', durableRoleScope('stated_correction', 'in'), NOW);
    establishNodeState(store.db, 'claim', { revision: 1, at: NOW });

    await expect(
      assemble({
        route: 'live_supersession',
        reservedUnits: 0,
        use: 'claim_judgment',
        sides: [
          { nodeId: 'claim', statement: 'one' },
          { nodeId: 'claim', statement: 'two' },
        ],
      }),
    ).rejects.toThrow('sized a whole payload');
  });
});

describe('entity judgment evidence at scale', () => {
  it('assembles a hub entity past the old relation and address counts, within its bounds', async () => {
    for (let index = 0; index < 300; index += 1) {
      capture({
        id: `left-${String(index)}`,
        session: `session-${String(index % 40)}`,
        minutesAgo: 10 + index,
        nodes: [LEFT],
        text: `Aion Local note ${String(index)}: the service answered.`,
      });
    }
    // Rows the committed view holds with no accepted source behind them. Together with the ones
    // above they take the entity past 4,096 relation rows and 256 addresses.
    store.db.transaction(() => {
      for (let index = 0; index < 3_900; index += 1) {
        commitIncidence(store.db, {
          sourceId: `unaccepted-${String(index)}`,
          nodeId: LEFT,
          role: 'mention',
          operationId: `unaccepted-${String(index)}`,
          at: NOW,
        });
      }
    })();
    capture({ id: 'right-1', minutesAgo: 5, nodes: [RIGHT], text: 'Aion Cognition is the repo.' });
    const budget = new RequestBudget();

    const result = assembled(await assemble(pair(), budget));

    const left = result.sides[0];
    expect(left.evidence === 'excerpts' && left.unreadSourcesRemain).toBe(true);
    expect(excerptsOf(left).length).toBeGreaterThan(0);
    expect(excerptsOf(left).length).toBeLessThanOrEqual(12);
    expect(left.renderedContext).toContain('More sources are recorded against it');
    const spent = budget.spent();
    expect(spent.relation_rows).toBeLessThanOrEqual(68);
    expect(spent.requested_ids).toBeLessThanOrEqual(25);
    expect(spent.decoded_raw_bytes).toBeLessThanOrEqual(EVIDENCE_LIMITS.decodedRawBytes);
    expect(renderedUnits(result)).toBeLessThanOrEqual(renderableUnits(pair()));

    const prompt = describeEntityMergePair(
      withEvidence(
        {
          subject: { name: 'Aion Local', aliases: ['aion-local'], type: 'project', typeCounts: {} },
          candidate: { name: 'Aion Cognition', aliases: [], type: 'project', typeCounts: {} },
          facts: [],
        },
        { ...result, status: 'ready' },
      ),
    );
    expect(prompt).toContain('Aion Local note 10');
    expect(
      admitRenderedInput('entity_merge', [{ content: DETECT_PROMPT }, { content: prompt }]),
    ).toEqual({ status: 'admitted' });
  }, 60_000);

  it('reaches long captures by decoding only the part it shows', async () => {
    const stopCapture = (index: number, namedTool: boolean): ReflectionContent => ({
      turns: [
        { role: 'user', text: 'carry on', occurred_at: minutesAgo(index) },
        { role: 'assistant', text: `Aion Local ${'y'.repeat(40_000)}` },
      ],
      tool_executions: Array.from({ length: 64 }, (_, tool) => ({
        tool: 'Read',
        status: 'ok' as const,
        input: { path: `/repo/file-${String(tool)}` },
        output:
          namedTool && tool === 40 ? `the Aion Local service ${'z'.repeat(800)}` : 'z'.repeat(850),
      })),
    });
    for (let index = 0; index < 20; index += 1) {
      capture({
        id: `stop-${String(index)}`,
        minutesAgo: 10 + index,
        nodes: [LEFT],
        content: stopCapture(10 + index, true),
      });
    }
    // The newest capture names the entity only inside the one oversized turn.
    capture({ id: 'stop-unnamed', minutesAgo: 1, nodes: [LEFT], content: stopCapture(1, false) });
    capture({ id: 'right-1', minutesAgo: 5, nodes: [RIGHT], text: 'Aion Cognition is the repo.' });
    const payloadBytes = store.db
      .prepare('SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM experience_archive')
      .get() as { bytes: number };
    const budget = new RequestBudget();

    const result = assembled(await assemble(pair(), budget));

    const shown = excerptsOf(result.sides[0]);
    expect(shown.length).toBeGreaterThan(0);
    for (const excerpt of shown) {
      expect(excerpt).toMatchObject({ partKind: 'tool_execution', ordinal: 40 });
      expect(excerpt.text).toContain('the Aion Local service');
    }
    expect(result.sides[0].renderedContext).toContain(
      '1 source whose mention sits only in parts over 32768 bytes',
    );
    expect(budget.spent().decoded_raw_bytes).toBeLessThanOrEqual(EVIDENCE_LIMITS.decodedRawBytes);
    expect(budget.spent().decoded_raw_bytes).toBeLessThan(payloadBytes.bytes / 50);
  }, 60_000);
});

describe('entity judgment evidence selection', () => {
  it('keeps a stated correction and an older shared statement visible past newer mentions', async () => {
    for (let index = 0; index < 14; index += 1) {
      capture({
        id: `recent-${String(index)}`,
        minutesAgo: 1 + index,
        nodes: [LEFT],
        text: `Aion Local came up again (${String(index)}).`,
      });
    }
    capture({
      id: 'old-shared',
      minutesAgo: 500,
      nodes: [LEFT, RIGHT],
      text: 'Aion Local and Aion Cognition are different projects. One is the service.',
    });
    capture({
      id: 'old-correction',
      minutesAgo: 600,
      nodes: [LEFT],
      role: 'stated_correction',
      text:
        `${'Some context first. '.repeat(80)}\n\n` +
        'Aion Local is the MCP service. It is not the whitepaper repo. That lives elsewhere.',
    });
    capture({ id: 'right-own', minutesAgo: 30, nodes: [RIGHT], text: 'Aion Cognition docs.' });

    const result = assembled(await assemble());

    expect(result.shared?.excerpts.map((excerpt) => excerpt.sourceId)).toEqual(['old-shared']);
    expect(result.shared?.renderedContext).toContain('are different projects');
    const left = excerptsOf(result.sides[0]);
    const correction = left.find((excerpt) => excerpt.nominatedAs === 'correction');
    expect(correction?.sourceId).toBe('old-correction');
    expect(correction?.text).toContain('It is not the whitepaper repo.');
    expect(left.filter((excerpt) => excerpt.nominatedAs === 'recent')).toHaveLength(10);
    expect(result.sides[0].renderedContext).toContain('[stated correction]');
  });

  it('reads the prompting episode first, and shows it once when it names neither entity yet', async () => {
    capture({ id: 'older', minutesAgo: 90, nodes: [LEFT], text: 'Aion Local, the older note.' });
    capture({ id: 'newer', minutesAgo: 5, nodes: [LEFT], text: 'Aion Local, the newer note.' });
    capture({ id: 'right-own', minutesAgo: 5, nodes: [RIGHT], text: 'Aion Cognition docs.' });
    capture({
      id: 'prompt',
      minutesAgo: 1,
      nodes: [],
      text: 'Is Aion Local the same as Aion Cognition?',
    });

    const recorded = assembled(await assemble(pair({ promptingSourceId: 'older' })));
    const unlinked = assembled(await assemble(pair({ promptingSourceId: 'prompt' })));

    expect(excerptsOf(recorded.sides[0])[0]).toMatchObject({
      sourceId: 'older',
      nominatedAs: 'prompting',
    });
    expect(recorded.sides[0].renderedContext.indexOf('[prompting episode]')).toBeLessThan(
      recorded.sides[0].renderedContext.indexOf('[recent]'),
    );
    expect(unlinked.shared?.excerpts.map((excerpt) => excerpt.sourceId)).toEqual(['prompt']);
    expect(unlinked.shared?.renderedContext).toContain('recorded against neither entity yet');
  });

  it('verifies a turn with no clock of its own against the episode clock it was recorded under', async () => {
    capture({
      id: 'unstamped',
      minutesAgo: 30,
      nodes: [LEFT],
      content: {
        turns: [
          { role: 'user', text: 'what runs the MCP server?', occurred_at: minutesAgo(30) },
          { role: 'assistant', text: 'Aion Local does.' },
        ],
      },
    });
    capture({ id: 'right-own', minutesAgo: 1, nodes: [RIGHT], text: 'Aion Cognition docs.' });

    const result = assembled(await assemble());

    expect(excerptsOf(result.sides[0])).toMatchObject([
      { sourceId: 'unstamped', partKind: 'turn', ordinal: 1, partOccurredAt: minutesAgo(30) },
    ]);
    expect(result.omitted).toEqual([]);
  });

  it('shows the head of a part, labeled, when no name is spelled in it', async () => {
    capture({ id: 'pronoun', minutesAgo: 1, nodes: [LEFT], text: 'It was renamed last week.' });
    capture({ id: 'right-own', minutesAgo: 1, nodes: [RIGHT], text: 'Aion Cognition docs.' });

    const result = assembled(await assemble());

    expect(excerptsOf(result.sides[0])).toMatchObject([
      { sourceId: 'pronoun', start: 0, placement: { kind: 'no_literal_match' } },
    ]);
    expect(result.sides[0].renderedContext).toContain('no literal mention of a name was found');
    expect(result.omitted).toEqual([]);
  });

  it('places the window on the original text of a name in another script', async () => {
    const text = 'İİİ the łódź hub meets 😀 on Friday, and ŁÓDŹ HUB again';
    capture({ id: 'unicode', minutesAgo: 1, nodes: [LEFT], text });
    capture({ id: 'right-own', minutesAgo: 1, nodes: [RIGHT], text: 'Aion Cognition docs.' });
    const unicode = pair();

    const result = assembled(
      await assemble({
        ...unicode,
        sides: [{ nodeId: LEFT, statement: 'Łódź Hub', names: ['Łódź Hub'] }, unicode.sides[1]],
      }),
    );

    const [excerpt] = excerptsOf(result.sides[0]);
    expect(excerpt?.placement).toEqual({ kind: 'literal', matched: 'łódź hub' });
    expect(`user: ${text}`.slice(excerpt?.start, excerpt?.end)).toBe(excerpt?.text);
    expect(LONE_SURROGATE.test(excerpt?.text ?? '')).toBe(false);
  });

  it('reads a shared source once and shows it once, under neither side', async () => {
    capture({
      id: 'both',
      minutesAgo: 2,
      nodes: [LEFT, RIGHT],
      text: 'Aion Local uses Aion Cognition.',
    });
    capture({ id: 'left-own', minutesAgo: 3, nodes: [LEFT], text: 'Aion Local alone.' });
    capture({ id: 'right-own', minutesAgo: 3, nodes: [RIGHT], text: 'Aion Cognition alone.' });
    const budget = new RequestBudget();

    const result = assembled(await assemble(pair(), budget));

    expect(result.shared?.excerpts.map((excerpt) => excerpt.sourceId)).toEqual(['both']);
    expect(excerptsOf(result.sides[0]).map((excerpt) => excerpt.sourceId)).toEqual(['left-own']);
    expect(excerptsOf(result.sides[1]).map((excerpt) => excerpt.sourceId)).toEqual(['right-own']);
    expect(result.sides[0].renderedContext).not.toContain('source both');
    expect(result.sides[1].renderedContext).not.toContain('source both');
    expect(budget.spent().requested_ids).toBe(3);
    const decoded = [
      ...(result.shared?.excerpts ?? []),
      ...excerptsOf(result.sides[0]),
      ...excerptsOf(result.sides[1]),
    ].reduce((total, excerpt) => total + excerpt.decodedRawUtf8Bytes, 0);
    expect(budget.spent().decoded_raw_bytes).toBe(decoded);
  });

  it('shows a redacted capture with its fingerprint whole and never the secret', async () => {
    const redacted = redactPayload({
      turns: [
        {
          role: 'user',
          text: 'Aion Local deploys with AKIAIOSFODNN7EXAMPLE, keep it safe.',
          occurred_at: minutesAgo(1),
        },
      ],
    }).value;
    capture({ id: 'secret', minutesAgo: 1, nodes: [LEFT], content: redacted });
    capture({ id: 'right-own', minutesAgo: 1, nodes: [RIGHT], text: 'Aion Cognition docs.' });

    const result = assembled(await assemble());

    const [excerpt] = excerptsOf(result.sides[0]);
    expect(excerpt?.text).toMatch(/⟨secret:aws-access-key:[0-9a-f]{6}⟩/);
    expect(result.sides[0].renderedContext).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('entity judgment evidence and what cannot be shown', () => {
  beforeEach(() => {
    capture({ id: 'left-a', minutesAgo: 1, nodes: [LEFT], text: 'Aion Local, first.' });
    capture({ id: 'left-b', minutesAgo: 2, nodes: [LEFT], text: 'Aion Local, second.' });
    capture({ id: 'right-own', minutesAgo: 1, nodes: [RIGHT], text: 'Aion Cognition docs.' });
  });

  it('names a withheld source without blocking the judgment on it', async () => {
    commitSourceState(store.db, {
      sourceId: 'left-a',
      stateKind: 'forgotten',
      operationId: 'forget-left-a',
      at: NOW,
    });

    const result = assembled(await assemble());

    expect(excerptsOf(result.sides[0]).map((excerpt) => excerpt.sourceId)).toEqual(['left-b']);
    expect(result.sides[0].renderedContext).toContain('1 source withheld from disclosure');
    expect(result.omitted.map((issue) => issue.reason)).toEqual(['suppressed_source']);
  });

  it('abstains when every source nominated for a side is withheld', async () => {
    for (const source of ['left-a', 'left-b']) {
      commitSourceState(store.db, {
        sourceId: source,
        stateKind: 'suppressed',
        operationId: `suppress-${source}`,
        at: NOW,
      });
    }

    const result = await assemble();

    expect(result).toMatchObject({ status: 'abstained', reason: 'required_source_suppressed' });
    expect(result.status === 'abstained' ? result.addresses : []).toEqual([
      { kind: 'id', id: 'left-a' },
      { kind: 'id', id: 'left-b' },
    ]);
  });

  it('names a part whose bytes no longer match its record, and still assembles', async () => {
    const archiveId = readSourceRecord(store.db, 'left-a')?.canonicalArchiveId;
    store.db
      .prepare(
        "UPDATE experience_archive SET payload_json = json_set(payload_json, '$.turns[0].text', ?) WHERE id = ?",
      )
      .run('Aion Local, rewritten after the fact.', archiveId);

    const result = assembled(await assemble());

    expect(excerptsOf(result.sides[0]).map((excerpt) => excerpt.sourceId)).toEqual(['left-b']);
    expect(result.sides[0].renderedContext).toContain(
      '1 source that could not be verified against its record',
    );
    expect(result.omitted).toContainEqual({
      address: { kind: 'part', sourceId: 'left-a', partKind: 'turn', ordinal: 0 },
      field: 'source_content',
      reason: 'unresolved_mapping',
      required: false,
    });
  });

  it.each([
    [
      'a shown source is forgotten',
      (): void => {
        commitSourceState(store.db, {
          sourceId: 'left-a',
          stateKind: 'forgotten',
          operationId: 'forget-late',
          at: NOW,
        });
      },
    ],
    [
      "a shown source's part mapping changes",
      (): void => {
        store.db
          .prepare("UPDATE source_parts SET content_hash = 'moved' WHERE source_id = 'left-a'")
          .run();
      },
    ],
    [
      'a correction about the other entity arrives',
      (): void => {
        capture({
          id: 'late-correction',
          minutesAgo: 0,
          nodes: [RIGHT],
          role: 'stated_correction',
          text: 'Aion Cognition is not a service.',
        });
        establishScope(store.db, RIGHT, durableRoleScope('stated_correction', 'in'), NOW);
      },
    ],
  ])('refuses the decision before it is applied when %s', async (_, change) => {
    const result = assembled(await assemble());

    change();

    expect(verifyEvidenceRevision(store.db, result.revision).status).toBe('stale');
  });

  it('keeps an uncounted role a gap rather than a sample', async () => {
    store.db
      .prepare(
        "UPDATE evidence_scope_versions SET census_status = 'unknown' WHERE endpoint_id = ? AND relation_class = ?",
      )
      .run(RIGHT, durableRoleScope('participation', 'in'));

    const result = await assemble();

    expect(result.status).toBe('incomplete');
    expect(result.status === 'incomplete' ? result.reasons : []).toContainEqual({
      address: { kind: 'id', id: RIGHT },
      field: 'source_content',
      reason: 'required_scope_missing',
      required: true,
    });
  });

  it('keeps an entity with no recorded source a gap', async () => {
    entity('entity-unmentioned');
    const request = pair();

    const result = await assemble({
      ...request,
      sides: [request.sides[0], { nodeId: 'entity-unmentioned', statement: 'Nobody' }],
    });

    expect(
      result.status === 'incomplete' ? result.reasons.map((issue) => issue.reason) : [],
    ).toEqual(['required_scope_missing']);
  });
});
