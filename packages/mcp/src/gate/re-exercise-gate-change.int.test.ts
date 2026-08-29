import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryPackItem } from '@aion/protocol';
import {
  closeSessionNarrative,
  findEpisodeCognitiveNodes,
  listSupersessionProposals,
  NARRATIVE_PROPERTIES,
  supersedeEpisode,
  type NarrativeDeps,
  type SupersessionProposal,
} from '@aion/core';
import { loadSessionSourceNodes } from '@aion/core/infrastructure/graph/narrative-queries.js';
import { SUPERSESSION_METHOD } from '@aion/core/infrastructure/graph/supersession-queries.js';
import {
  nodeProperties,
  relationshipsByProvenance,
} from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import { narrativeOptions } from '../bootstrap.js';
import {
  CHANGE_BATTERY,
  PLANNING_NARRATIVE,
  THIN_NARRATIVE,
  type ChangeCase,
  type NarrativeFixture,
} from './gate-batteries.fixture.js';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';

/**
 * What the substrate does when the world changes under it, and what it writes about a session
 * when nobody is watching. One substrate, because the correction battery and the supersession
 * battery are two readings of the same six-case set: four genuine corrections and two baits.
 *
 * Order matters here. The supersession set reads the graph the pipeline left; the correction
 * set then applies the corrections through `supersedeEpisode`, which closes nodes, so it has
 * to run second.
 */

const READ_SESSION = 'gate-change-read';
const BASELINE_AT = new Date('2026-07-01T09:00:00.000Z');
const CORRECTION_AT = new Date('2026-07-02T09:00:00.000Z');
const RECALLED_AT = new Date('2026-07-03T09:00:00.000Z');

const ENRICH_DEADLINE_MS = 1_500_000;

/**
 * The judge is a model, so the count of genuine reversals it catches is a measurement rather
 * than a guarantee. What is a guarantee is the mode: nothing may close. The last measurement
 * caught none at all, 0 true positives across two designed batteries, so this floor is one.
 */
const MIN_CORRECTIONS_PROPOSED = 1;

type Ranks = {
  /** Pack rank of the best-ranked item the episode is or produced; -1 when it carried none. */
  readonly corrected: number;
  readonly stale: number;
  readonly items: number;
  readonly served: readonly MemoryPackItem[];
};

type StoredCase = {
  readonly entry: ChangeCase;
  readonly baselineEpisodeId: string;
  readonly correctionEpisodeId: string;
  baselineNodeIds: readonly string[];
  correctionNodeIds: readonly string[];
};

const substrate = new GateSubstrate('change');
const cases: StoredCase[] = [];
let proposals: readonly SupersessionProposal[] = [];

function sessionFor(entry: ChangeCase): string {
  return `gate-change-${entry.key}`;
}

async function enrichAll(ids: readonly string[], label: string): Promise<void> {
  const worker = substrate.worker();
  await worker.start();
  await waitFor(label, ENRICH_DEADLINE_MS, () =>
    Promise.resolve(ids.every((id) => substrate.enriched(id))),
  );
  await worker.stop();
}

async function cognitiveIds(episodeId: string): Promise<readonly string[]> {
  const nodes = await findEpisodeCognitiveNodes(substrate.driver, episodeId);
  return nodes.map((node) => node.id);
}

/**
 * Best rank in the pack for anything the episode is or produced; -1 when it carried none.
 *
 * Ids alone are not enough. The enrichment that answers a corrected question may be an entity
 * gloss or a node minted outside `findEpisodeCognitiveNodes`'s reach, so a run where the pack
 * answered correctly at rank 1 has read as a miss purely on id bookkeeping. The answer's own
 * text is the second key: it is what the question was asked to get back.
 */
function bestRank(
  items: readonly { readonly id: string; readonly rank: number; readonly content: string }[],
  owned: ReadonlySet<string>,
  answer?: string,
): number {
  const needle = answer?.toLowerCase();
  const hit = items.find(
    (item) =>
      owned.has(item.id) ||
      (needle !== undefined && item.content.toLowerCase().includes(needle)),
  );
  return hit === undefined ? -1 : hit.rank;
}

beforeAll(async () => {
  await substrate.open();

  const baselineIds: string[] = [];
  for (const entry of CHANGE_BATTERY) {
    const stored = await substrate.store(
      { observations: [entry.baseline], summary: `${entry.subject}, as first recorded` },
      { identity: sessionFor(entry), now: BASELINE_AT },
    );
    baselineIds.push(stored.episode_id);
    cases.push({
      entry,
      baselineEpisodeId: stored.episode_id,
      correctionEpisodeId: '',
      baselineNodeIds: [],
      correctionNodeIds: [],
    });
  }
  await enrichAll(baselineIds, 'the six baselines to enrich');

  // The corrections land only once the baselines are enriched, which is what gives the
  // supersession stage current claims to judge against. Measured in this order too.
  for (const held of cases) {
    const stored = await substrate.store(
      { observations: [held.entry.next], summary: `${held.entry.subject}, revised` },
      { identity: sessionFor(held.entry), now: CORRECTION_AT },
    );
    Object.assign(held, { correctionEpisodeId: stored.episode_id });
  }
  await enrichAll(
    cases.map((held) => held.correctionEpisodeId),
    'the six corrections to enrich',
  );

  for (const held of cases) {
    held.baselineNodeIds = await cognitiveIds(held.baselineEpisodeId);
    held.correctionNodeIds = await cognitiveIds(held.correctionEpisodeId);
  }
  proposals = listSupersessionProposals(substrate.db);
}, 3_600_000);

afterAll(async () => {
  await substrate.close();
});

describe('the six-case supersession set in propose mode', () => {
  it('closes nothing, whatever the judge said', async () => {
    const written = await relationshipsByProvenance(substrate.driver, SUPERSESSION_METHOD);
    expect(written).toEqual([]);

    for (const held of cases) {
      for (const id of held.baselineNodeIds) {
        const properties = await nodeProperties(substrate.driver, id);
        expect(properties.valid_until ?? undefined).toBeUndefined();
      }
    }
  }, 180_000);

  it('records the judgments it did make as reviewable proposals', () => {
    const corrections = CHANGE_BATTERY.filter((entry) => entry.kind === 'correction');
    const baits = CHANGE_BATTERY.filter((entry) => entry.kind === 'bait');
    const owned = (entry: ChangeCase): ReadonlySet<string> => {
      const held = cases.find((row) => row.entry.key === entry.key);
      return new Set(held?.baselineNodeIds ?? []);
    };
    const proposed = (entry: ChangeCase): number =>
      proposals.filter((row) => owned(entry).has(row.oldId)).length;

    const caught = corrections.filter((entry) => proposed(entry) > 0).length;
    const baited = baits.filter((entry) => proposed(entry) > 0).length;
    console.log(
      `supersession battery: ${String(caught)}/${String(corrections.length)} corrections proposed, ` +
        `${String(baited)}/${String(baits.length)} baits proposed, ` +
        `${String(proposals.length)} proposal rows, 0 closures`,
    );

    expect(caught).toBeGreaterThanOrEqual(MIN_CORRECTIONS_PROPOSED);
    for (const row of proposals) {
      expect(row.resolvedAt).toBeNull();
      expect(row.newId).not.toBe(row.oldId);
    }
  });
});

describe('the four corrections, read back', () => {
  const corrections = CHANGE_BATTERY.filter((entry) => entry.kind === 'correction');

  function held(entry: ChangeCase): StoredCase {
    const found = cases.find((row) => row.entry.key === entry.key);
    if (found === undefined) {
      throw new Error(`case ${entry.key} was never stored`);
    }
    return found;
  }

  async function ask(entry: ChangeCase, phase: string): Promise<Ranks> {
    const row = held(entry);
    const result = await substrate.recall(entry.query, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });
    const ranks: Ranks = {
      corrected: bestRank(
        result.items,
        new Set([row.correctionEpisodeId, ...row.correctionNodeIds]),
        entry.answer,
      ),
      stale: bestRank(result.items, new Set([row.baselineEpisodeId, ...row.baselineNodeIds])),
      items: result.items.length,
      served: result.items,
    };
    console.log(
      `correction ${phase} "${entry.query}": corrected (${entry.answer}) at rank ` +
        `${String(ranks.corrected)}, pre-correction at rank ${String(ranks.stale)}, ` +
        `${String(ranks.items)} items; top: ` +
        result.items
          .slice(0, 3)
          .map((item) => `[${String(item.rank)} ${item.currency}] ${item.content.slice(0, 50)}`)
          .join(' | '),
    );
    return ranks;
  }

  /**
   * Measured, not gated. In propose mode a judged contradiction is a review row and nothing
   * else, so an enriched correction on its own leaves the earlier claim open and competing.
   * These numbers are re-measured against the current pipeline; the gate is the assertion
   * below, on what recall answers once the correction has actually been applied.
   */
  it.each(corrections)('records where $key ranks before the correction is applied', async (entry) => {
    const before = await ask(entry, 'before');
    expect(before.items).toBeGreaterThan(0);
  }, 180_000);

  it.each(corrections)('answers $query with the corrected value once applied', async (entry) => {
    const row = held(entry);
    const applied = await supersedeEpisode(substrate.driver, {
      oldId: row.baselineEpisodeId,
      newId: row.correctionEpisodeId,
      now: RECALLED_AT,
    });
    expect(applied.supersession.newId).toBe(row.correctionEpisodeId);

    // The derived family closes with its episode, which is what stops a stale extracted fact
    // from answering as `current` long after its episode was corrected.
    const closed = new Set(applied.propagation.closedIds);
    for (const id of row.baselineNodeIds) {
      const properties = await nodeProperties(substrate.driver, id);
      const stillOpen = (properties.valid_until ?? undefined) === undefined;
      expect(stillOpen).toBe(!closed.has(id));
    }

    const after = await ask(entry, 'after ');
    expect(after.corrected).toBeGreaterThan(0);
    // A superseded memory is still served, with its lineage: currency-aware, not
    // currency-filtered. It may no longer outrank the correction, and it may no longer claim
    // to be current. The reverse was measured on three of four questions.
    if (after.stale > 0) {
      expect(after.corrected).toBeLessThan(after.stale);
    }
    const stale = new Set([row.baselineEpisodeId, ...closed]);
    for (const item of after.served) {
      if (stale.has(item.id)) {
        expect(item.currency).toBe('superseded');
        expect(item.superseded_by?.id).toBeDefined();
      }
    }
  }, 180_000);
});

describe('narrative grounding on the fabrication fixtures', () => {
  type Narration = {
    readonly sentences: number;
    readonly chars: number;
    /** Citations that resolve to a node the pipeline extracted, not to the episode itself. */
    readonly extracted: number;
  };

  async function narrate(fixture: NarrativeFixture): Promise<Narration> {
    const stored = await substrate.store(fixture.payload, { identity: fixture.identity });
    await enrichAll([stored.episode_id], `${fixture.identity} to enrich`);

    const deps: NarrativeDeps = {
      driver: substrate.driver,
      provider: substrate.provider,
      logger: substrate.logger,
    };
    const result = await closeSessionNarrative(
      deps,
      fixture.identity,
      narrativeOptions(substrate.config),
    );
    expect(result.status).toBe('created');

    const properties = await nodeProperties(substrate.driver, result.narrativeId as string);
    const sources = await loadSessionSourceNodes(substrate.driver, fixture.identity);
    const claims = new Set(sources.map((source) => source.id));
    const citable = new Set([stored.episode_id, ...claims]);
    const citations = properties[NARRATIVE_PROPERTIES.citations] as string[];
    const text = String(properties.text ?? '');
    const narration: Narration = {
      sentences: Number(properties[NARRATIVE_PROPERTIES.sentenceCount]),
      chars: text.length,
      extracted: citations.filter((id) => claims.has(id)).length,
    };

    console.log(
      `narrative ${fixture.identity}: ${String(narration.sentences)} sentences, ` +
        `${String(citations.length)} citations (${String(narration.extracted)} to extracted ` +
        `claims of ${String(claims.size)}), ${String(narration.chars)} chars`,
    );

    expect(citations.length).toBeGreaterThan(0);
    // Every citation resolves to something the session actually holds; a narrative that cites
    // a node outside its own session is citing something it never read.
    expect(citations.every((id) => citable.has(id))).toBe(true);
    for (const invention of fixture.inventions) {
      expect(text.toLowerCase()).not.toContain(invention.toLowerCase());
    }
    return narration;
  }

  it('turns the 27-word probe into one grounded sentence, not eight invented ones', async () => {
    const thin = await narrate(THIN_NARRATIVE);
    expect(thin.sentences).toBe(1);
    // The measured numbers for this exact source: 8 sentences, 493 characters, a 12x expansion.
    expect(thin.chars).toBeLessThan(493);
  }, 600_000);

  it('scales with its source and cites what the planning session extracted', async () => {
    const planning = await narrate(PLANNING_NARRATIVE);
    expect(planning.sentences).toBeGreaterThan(1);
    // The platitude failure: a narrative that names none of the session's decisions and cites
    // only the episode it compressed reads as history and carries none of it.
    expect(planning.extracted).toBeGreaterThan(0);
  }, 600_000);
});
