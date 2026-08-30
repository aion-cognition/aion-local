import {
  bootstrapBackbone,
  CueCache,
  DEFAULTS,
  handleRecall,
  handleReflection,
  LaneAssigner,
  openLogger,
  openSqliteHandle,
  ReflectionOrchestrator,
  ReflectionWorker,
  runGraphMigrations,
  SessionManager,
  isLedgerApplied,
  orchestratorLedgerKey,
  type AdmissionReport,
  type Config,
  type Logger,
  type Provider,
  type RecallCompletion,
  type RecallDeps,
  type ReflectionIntakeDeps,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { testGenerationProvider } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import type { MemoryPack, MemoryPackItem, ReflectionOutput } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reflectionStages, workerOptions } from '../bootstrap.js';

/**
 * The substrate every gate battery runs on: a throwaway Neo4j, its own SQLite, a live model,
 * and the pipeline `bootstrap.ts` assembles for the shipped service. Nothing here stands in
 * for a model, and no stage list is written twice: a battery that passed against a pipeline
 * wired only in a test would say nothing about the thing that ships.
 *
 * The gate files share this rather than one another's substrate: each takes its own lease on
 * the harness for its own batteries, clearing the graph on the way in, so a battery that
 * writes (corrections, supersession) cannot move the floor another battery measures.
 */

const MEMBER_NAME = 'Ryan Huber';

export type GateRecallResult = {
  readonly pack: MemoryPack;
  /** What the admission gate considered, admitted, and dropped, and why. */
  readonly admission: AdmissionReport;
  /** Every bucket flattened in rank order: what the agent actually got back. */
  readonly items: readonly MemoryPackItem[];
  /** Seeds with their provenance, so a battery can say which leg admitted a pack. */
  readonly seeds: RecallCompletion['seeds'];
};

export type GateStoreOptions = {
  readonly identity: string;
  readonly now?: Date;
};

export type GateSubstrateOptions = {
  /**
   * Applied to the shipped defaults once, at construction. A battery narrows a knob only when
   * the shipped value makes its own claim untestable, and says which claim in its own file.
   */
  readonly tune?: (config: Config) => Config;
};

export class GateSubstrate {
  readonly label: string;
  readonly config: Config;
  readonly #lanes: LaneAssigner;
  /** The worker `intakeDeps` wakes, set by `worker()`. A substrate with none just enqueues. */
  #worker: ReflectionWorker | undefined;
  #harness: Neo4jHarness | undefined;
  #db: SqliteHandle | undefined;
  #logger: Logger | undefined;
  #sessions: SessionManager | undefined;
  #provider: Provider | undefined;
  #dataDir = '';

  constructor(label: string, options: GateSubstrateOptions = {}) {
    this.label = label;
    const shipped: Config = {
      ...DEFAULTS,
      ollama: {
        ...DEFAULTS.ollama,
        url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      },
      // The one departure from the shipped defaults, and it is what makes a battery a battery:
      // every question is asked of one reading session, and each answer has to be judged on what
      // the substrate holds rather than on what an earlier question served or what that session
      // wrote itself.
      recall: { ...DEFAULTS.recall, sessionDedup: false, ownSessionFilter: false },
    };
    this.config = options.tune === undefined ? shipped : options.tune(shipped);
    this.#lanes = new LaneAssigner(this.config.lanes);
  }

  async open(): Promise<void> {
    this.#harness = await startNeo4jHarness();
    this.#dataDir = mkdtempSync(join(tmpdir(), `aion-gate-${this.label}-`));
    this.#db = openSqliteHandle({ filePath: join(this.#dataDir, 'aion.sqlite') });
    this.#logger = openLogger({ filePath: join(this.#dataDir, 'aion.jsonl'), level: 'warn' });

    await runGraphMigrations(this.driver, this.db, {
      embedDimension: this.config.models.embedDimension,
    });
    const backbone = await bootstrapBackbone(this.driver, { memberName: MEMBER_NAME });
    this.#sessions = new SessionManager(this.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    });
    this.#provider = testGenerationProvider({
      baseUrl: this.config.ollama.url,
      embedModel: this.config.models.embed,
    });
  }

  async close(): Promise<void> {
    await stopNeo4jHarness(this.#harness);
    this.#harness = undefined;
    this.#db?.close();
    this.#db = undefined;
    if (this.#dataDir !== '') {
      rmSync(this.#dataDir, { recursive: true, force: true });
      this.#dataDir = '';
    }
  }

  get driver(): Neo4jHarness['driver'] {
    if (this.#harness === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#harness.driver;
  }

  get db(): SqliteHandle {
    if (this.#db === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#db;
  }

  get logger(): Logger {
    if (this.#logger === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#logger;
  }

  get provider(): Provider {
    if (this.#provider === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#provider;
  }

  get sessions(): SessionManager {
    if (this.#sessions === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#sessions;
  }

  intakeDeps(): ReflectionIntakeDeps {
    return {
      driver: this.driver,
      db: this.db,
      sessions: this.sessions,
      provider: this.provider,
      onJobEnqueued: () => {
        this.#worker?.wake();
      },
      logger: this.logger,
      entropyThreshold: this.config.redaction.entropyThreshold,
      // One assigner for the substrate's life, as the service holds one. Constructed per call
      // it would see one arrival per window and never demote anything, which would leave the
      // rate backstop untestable here and the starvation battery covering the flag path only.
      lanes: this.#lanes,
      workerMaxAttempts: this.config.operational.workerMaxAttempts,
    };
  }

  /** The shipped stage list, from `bootstrap.ts`, over this substrate. */
  orchestrator(): ReflectionOrchestrator {
    return new ReflectionOrchestrator(
      { driver: this.driver, db: this.db, provider: this.provider, logger: this.logger },
      reflectionStages(this.config),
    );
  }

  worker(): ReflectionWorker {
    this.#worker = new ReflectionWorker(
      {
        driver: this.driver,
        db: this.db,
        provider: this.provider,
        runner: this.orchestrator(),
        logger: this.logger,
      },
      workerOptions(this.config),
    );
    return this.#worker;
  }

  store(payload: unknown, options: GateStoreOptions): Promise<ReflectionOutput> {
    return handleReflection(this.intakeDeps(), payload, {
      identity: options.identity,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * A recall through the whole read path, cue model included. The cue cache is fresh per call
   * so one battery's query cannot answer another's, and the admission report is captured from
   * the listener the service uses for its own side effects.
   */
  async recall(query: string, options: GateStoreOptions): Promise<GateRecallResult> {
    let completion: RecallCompletion | undefined;
    const deps: RecallDeps = {
      driver: this.driver,
      db: this.db,
      sessions: this.sessions,
      provider: this.provider,
      config: this.config,
      cueCache: new CueCache(),
      logger: this.logger,
      onRecalled: (served) => {
        completion = served;
      },
    };

    const pack = await handleRecall(
      deps,
      { query },
      {
        identity: options.identity,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    if (completion === undefined) {
      throw new Error('recall completed without reporting an admission decision');
    }
    return {
      pack,
      admission: completion.admission,
      seeds: completion.seeds,
      items: flatten(pack),
    };
  }

  /** True once the orchestrator has recorded a run for the episode, whatever it produced. */
  enriched(episodeId: string): boolean {
    return isLedgerApplied(this.db, orchestratorLedgerKey(episodeId));
  }
}

/**
 * Rank order across the whole pack, which is the order the reader sees. Buckets are a layout,
 * so a rank comparison that only looked inside one of them would miss the item that beat it.
 */
export function flatten(pack: MemoryPack): readonly MemoryPackItem[] {
  return [
    ...(pack.facts ?? []),
    ...(pack.episodes ?? []),
    ...(pack.narratives ?? []),
    ...(pack.preferences ?? []),
    ...(pack.resonant ?? []),
  ].sort((left, right) => left.rank - right.rank);
}

export async function waitFor(
  label: string,
  deadlineMs: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}
