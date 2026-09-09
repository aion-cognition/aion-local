import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor } from './wait-for.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  normalizeCognitiveText,
  TEXT_NORM_PROPERTY,
} from '../../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { vectorSeeds } from '../../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type {
  Provider,
  StructuredRequest,
  Vector,
} from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { handleReflection } from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { directIntakePublisher } from '../../../reflection/test-support/direct-intake.fixture.js';
import { SessionManager } from '../../../session/session-manager.js';
import { CueCache } from '../cues.js';
import { handleRecall, type RecallDeps } from '../recall.js';

/**
 * The substrate the provenance suites run on: a throwaway Neo4j, its own SQLite, and a stub
 * provider, seeded with the source records those suites read back.
 *
 * The graph is hand-built where the shape is the subject and pushed through reflection where the
 * reference handling is. Content vectors are written rather than embedded: what is under test is
 * the provenance contract, not extraction quality or the embedding model.
 *
 * Each suite takes its own instance and its own harness lease, so a file that writes cannot move
 * what another file reads, and every file states its own prerequisites by seeding them.
 */

export const EMBED_DIMENSION = 8;

const MEMBER_NAME = 'Ryan Huber';

export const SEEDED_AT = new Date('2026-06-01T09:00:00.000Z');
export const SUPERSEDED_AT = new Date('2026-06-05T09:00:00.000Z');
export const BEFORE_SUPERSESSION = new Date('2026-06-03T09:00:00.000Z');
export const RECALLED_AT = new Date('2026-06-09T09:00:00.000Z');

export const QUERY = 'how does the ingest queue drain';

export const ROOT_ID = 'prov-root-episode';
export const TURN_EPISODE_ID = 'prov-turn-episode';
export const TURN_ID = 'prov-stale-turn';
export const OLD_CLAIM_ID = 'prov-old-claim';
export const NEW_CLAIM_ID = 'prov-new-claim';
export const SUBJECT_ID = 'prov-subject-entity';
export const CLAIM_EPISODE_ID = 'prov-claim-episode';
export const FAMILY_CLAIM_ID = 'prov-family-claim';

const SUBJECT_NAME = 'ingest queue';
/** Opens on its own words: the near-duplicate cap keys on the first sixteen characters. */
export const FAMILY_CLAIM_TEXT = 'a worker is what drains the ingest queue, and nothing else does';

// Each pushed observation opens with its own marker. The near-duplicate cap keys on the first
// sixteen characters of an item's content, and every observation renders under one prefix, so
// three that opened alike would be one cluster and the cap would drop the third.
const ALPHA_MARKER = 'alphaward';
const BETA_MARKER = 'betaward';
const CORRECTION_MARKER = 'gammaward';
const CONFIRMER_MARKER = 'deltaward';

export const CONFIRMER = 'Ryan Huber';
export const CONFIRMATION_EVIDENCE = 'review thread 41';

/**
 * Every node shares one strong component with the cue and carries a distinct axis of its own,
 * so all of them clear the vector floor and no two sit close enough for near-duplicate
 * suppression to fold them together.
 */
export function unit(axis: number, shared = 0.7): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  raw[0] = shared;
  raw[axis] = 0.7;
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

export const CUE_VECTOR = unit(0, 0.99);
/** Off the shared axis entirely, so the turn's own episode never reaches the pack. */
export const OFF_TOPIC = unit(7, 0.001);

export const VECTORS: Readonly<Record<string, Vector>> = {
  root: unit(1),
  alpha: unit(2),
  beta: unit(3),
  correction: unit(4),
  turn: unit(5),
  oldClaim: unit(6),
  newClaim: unit(7),
};

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes(ALPHA_MARKER)) {
    return VECTORS.alpha ?? CUE_VECTOR;
  }
  if (lowered.includes(BETA_MARKER)) {
    return VECTORS.beta ?? CUE_VECTOR;
  }
  if (lowered.includes(CORRECTION_MARKER)) {
    return VECTORS.correction ?? CUE_VECTOR;
  }
  if (lowered.includes(CONFIRMER_MARKER)) {
    return OFF_TOPIC;
  }
  return CUE_VECTOR;
}

/** The query text as the cue model would hand it back: one query cue, the caller's own words. */
function queryOf(request: StructuredRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  const match = /Query:\n(.*)/.exec(user?.content ?? '');
  return match?.[1]?.trim() ?? '';
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: (request) =>
    Promise.resolve({
      query_cues: [queryOf(request)],
      summary_cues: [],
      recent_turn_cues: [],
    }),
};

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 20, tokenBudget: 6000 },
  };
}

export type StatedReferences = {
  readonly supersedes?: readonly string[];
  readonly derived_from?: readonly string[];
  readonly confirmations?: readonly {
    readonly target: string;
    readonly by: string;
    readonly evidence: string;
  }[];
};

export class ClaimProvenanceSubstrate {
  readonly label: string;
  #harness: Neo4jHarness | undefined;
  #db: SqliteHandle | undefined;
  #logger: Logger | undefined;
  #deps: RecallDeps | undefined;
  #dataDir = '';
  /** Set by `open()`, once the four seeded observations have been pushed through intake. */
  alphaId = '';
  betaId = '';
  correctionId = '';
  confirmerId = '';

  constructor(label: string) {
    this.label = label;
  }

  get driver(): Driver {
    if (this.#harness === undefined) {
      throw new Error('substrate is not open');
    }
    return this.#harness.driver;
  }

  get db(): SqliteHandle {
    if (this.#db === undefined) {
      throw new Error('substrate is not open');
    }
    return this.#db;
  }

  get logger(): Logger {
    if (this.#logger === undefined) {
      throw new Error('substrate is not open');
    }
    return this.#logger;
  }

  get deps(): RecallDeps {
    if (this.#deps === undefined) {
      throw new Error('substrate is not open');
    }
    return this.#deps;
  }

  get provider(): Provider {
    return provider;
  }

  async open(): Promise<void> {
    this.#harness = await startNeo4jHarness();
    this.#dataDir = mkdtempSync(join(tmpdir(), `aion-${this.label}-int-`));
    this.#db = openSqliteHandle({ filePath: join(this.#dataDir, 'aion.sqlite') });
    this.#logger = openLogger({ filePath: join(this.#dataDir, 'aion.jsonl'), level: 'debug' });
    await runGraphMigrations(this.driver, this.db, { embedDimension: EMBED_DIMENSION });

    const backbone = await bootstrapBackbone(this.driver, { memberName: MEMBER_NAME });
    this.#deps = {
      driver: this.driver,
      db: this.db,
      sessions: new SessionManager(this.driver, {
        memberId: backbone.member.id,
        workspaceId: backbone.workspace.id,
      }),
      provider,
      config: config(),
      cueCache: new CueCache(),
      logger: this.logger,
    };

    await this.#seed();
  }

  async close(): Promise<void> {
    if (this.#harness !== undefined) {
      await stopNeo4jHarness(this.#harness);
    }
    this.#db?.close();
    if (this.#dataDir.length > 0) {
      rmSync(this.#dataDir, { recursive: true, force: true });
    }
  }

  async push(
    observation: string,
    identity: string,
    provenance?: StatedReferences,
    now: Date = SEEDED_AT,
  ): Promise<string> {
    const result = await handleReflection(
      {
        driver: this.driver,
        db: this.db,
        sessions: this.deps.sessions,
        provider,
        logger: this.logger,
        entropyThreshold: DEFAULTS.redaction.entropyThreshold,
        lanes: new LaneAssigner(DEFAULTS.lanes),
        workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
        // The acceptance clock is the caller's, not the wall clock. Every historical read here
        // pins a moment in the seeded window, and a source accepted at the real current time is
        // outside all of them: the knowledge-time reads would answer empty and a confirmation
        // that stated no moment would be dated to the run rather than to the push.
        publications: directIntakePublisher(this.driver, this.db, () => now),
        acceptHookCapture: true,
      },
      { observations: [observation], ...(provenance === undefined ? {} : { provenance }) },
      { identity, now },
    );
    return result.episode_id;
  }

  async writeEpisode(id: string, text: string, vector: Vector): Promise<void> {
    await writeStampedNode(this.driver, {
      label: 'Episode',
      id,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: { text, session_id: `${id}-session`, content_vec: [...vector] },
    });
  }

  async writeClaim(id: string, text: string, vector: Vector): Promise<void> {
    await writeStampedNode(this.driver, {
      label: 'Insight',
      id,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: {
        text,
        [TEXT_NORM_PROPERTY]: normalizeCognitiveText(text),
        content_vec: [...vector],
      },
    });
  }

  async recall(identity: string, payload: Record<string, unknown> = {}) {
    return handleRecall(this.deps, { query: QUERY, ...payload }, { identity, now: RECALLED_AT });
  }

  async #seed(): Promise<void> {
    await this.writeEpisode(
      ROOT_ID,
      'root capture: the ingest queue drain design review',
      VECTORS.root ?? CUE_VECTOR,
    );
    await this.writeEpisode(TURN_EPISODE_ID, 'an unrelated capture', OFF_TOPIC);

    await writeStampedNode(this.driver, {
      label: 'Turn',
      id: TURN_ID,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: {
        text: 'the ingest queue drains itself overnight without a worker',
        role: 'user',
        sequence: 1,
        session_id: `${TURN_EPISODE_ID}-session`,
        source_episode_id: TURN_EPISODE_ID,
        extraction_method: 'reflection_intake',
        content_vec: [...(VECTORS.turn ?? CUE_VECTOR)],
      },
    });

    await this.writeClaim(
      OLD_CLAIM_ID,
      'the ingest queue drain rate was capped at 200 rows a second',
      VECTORS.oldClaim ?? CUE_VECTOR,
    );
    await this.writeClaim(
      NEW_CLAIM_ID,
      'the ingest queue drain rate is capped at 900 rows a second',
      VECTORS.newClaim ?? CUE_VECTOR,
    );
    await supersede(this.driver, {
      oldId: OLD_CLAIM_ID,
      newId: NEW_CLAIM_ID,
      now: SUPERSEDED_AT,
    });

    // The turn's subject family: an entity whose stored name sits inside the turn's own fold, and
    // a current claim about it extracted somewhere else. Nothing distils a turn into a claim, so
    // this is the only thing that can stand beside the belief the turn states.
    await writeStampedNode(this.driver, {
      label: 'Entity',
      id: SUBJECT_ID,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: {
        name: SUBJECT_NAME,
        name_norm: SUBJECT_NAME,
        type: 'concept',
        text: `${SUBJECT_NAME} (concept): the path uploads take into storage`,
        content_vec: [...OFF_TOPIC],
      },
    });
    await this.writeEpisode(CLAIM_EPISODE_ID, 'a separate look at the drain path', OFF_TOPIC);
    // Near the turn and away from the cue, so no leg admits the claim on its own: the annotation
    // under the turn is the only way it reaches the pack, which is what the assertion measures.
    await this.writeClaim(FAMILY_CLAIM_ID, FAMILY_CLAIM_TEXT, unit(5, 0.001));
    await upsertEdge(this.driver, {
      type: 'EXTRACTED_FROM',
      sourceId: FAMILY_CLAIM_ID,
      targetId: CLAIM_EPISODE_ID,
      strength: 1,
      confidence: 1,
      signals: ['provenance'],
      provenance: ['test-fixture'],
      count: 0,
      now: SEEDED_AT,
    });

    this.alphaId = await this.push(
      `${ALPHA_MARKER} drains the ingest queue through a webhook worker`,
      'prov-session-alpha',
      { derived_from: [ROOT_ID] },
    );
    this.betaId = await this.push(
      `${BETA_MARKER} samples the ingest queue drain rate hourly`,
      'prov-session-beta',
      { derived_from: [ROOT_ID] },
    );
    this.correctionId = await this.push(
      `${CORRECTION_MARKER} means the ingest queue needs a worker to drain at all`,
      'prov-session-correction',
      { supersedes: [TURN_ID], derived_from: ['prov-nothing-holds-this'] },
    );
    this.confirmerId = await this.push(
      `${CONFIRMER_MARKER} notes the drain path`,
      'prov-session-confirm',
      { confirmations: [{ target: this.alphaId, by: CONFIRMER, evidence: CONFIRMATION_EVIDENCE }] },
    );

    // Every node the assertions read has to be reachable by the vector leg before the first
    // recall runs: the index is eventually consistent, and a suite that runs while it catches up
    // measures the lag rather than the pack.
    await waitFor('the vector index to cover every written node', async () => {
      const rows = await vectorSeeds(this.driver, {
        vector: CUE_VECTOR,
        limit: 40,
        mode: withCurrency(),
      });
      const found = new Set(rows.map((row) => row.id));
      return [
        ROOT_ID,
        TURN_ID,
        OLD_CLAIM_ID,
        NEW_CLAIM_ID,
        this.alphaId,
        this.betaId,
        this.correctionId,
        this.confirmerId,
      ].every((id) => found.has(id));
    });
  }
}
