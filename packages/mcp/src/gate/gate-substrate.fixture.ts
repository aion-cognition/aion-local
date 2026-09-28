import {
  bootstrapBackbone,
  CueCache,
  DEFAULTS,
  handleRecall,
  handleReflection,
  INSTALLED_PUBLICATION_HANDLERS,
  LaneAssigner,
  openLogger,
  openSqliteHandle,
  PublicationCoordinator,
  ReflectionOrchestrator,
  ReflectionWorker,
  runGraphMigrations,
  SessionManager,
  isLedgerApplied,
  orchestratorLedgerKey,
  PIPELINE_VERSION,
  type AdmissionReport,
  type Config,
  type Logger,
  type Provider,
  type RecallCompletion,
  type RecallDeps,
  type ReflectionIntakeDeps,
  type SqliteHandle,
  EvidenceResolver,
  CoveredJudgmentEvidence,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import {
  openCampaignProducer,
  type CampaignProducerHandle,
} from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import {
  testGenerationConfig,
  testGenerationKey,
  testGenerationProvider,
} from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import {
  directCompletionPublisher,
  directIntakePublisher,
  drainAcceptedVectors,
} from '@aion/core/reflection/test-support/direct-intake.fixture.js';
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
  /**
   * Compose the judgment evidence seam the service composes (`bootstrap.ts`).
   *
   * Off, a judging stage reads for itself and every pair is `unchecked`, which is what the
   * precision batteries measure: they score the judge's answers, and the seam decides which pairs
   * reach it rather than what it says about one. A battery whose subject IS whether a pair reaches
   * the judge turns it on, and then the stage runs exactly as the service runs it.
   */
  readonly certifyJudgments?: boolean;
};

/**
 * The batteries measure the shipped configuration, and every generation in it needs a key. With
 * none, there is nothing to measure against: a pinned default judged on a substrate that made no
 * model call is a number about nothing. The batteries skip, visibly, instead.
 */
export const REMOTE_JUDGE_ABSENT = testGenerationKey() === '';

export class GateSubstrate {
  readonly label: string;
  readonly config: Config;
  readonly #lanes: LaneAssigner;
  readonly #certifyJudgments: boolean | undefined;
  /** The worker `intakeDeps` wakes, set by `worker()`. A substrate with none just enqueues. */
  #worker: ReflectionWorker | undefined;
  #harness: Neo4jHarness | undefined;
  #db: SqliteHandle | undefined;
  #publications: PublicationCoordinator | undefined;
  #logger: Logger | undefined;
  #sessions: SessionManager | undefined;
  #provider: Provider | undefined;
  #producer: CampaignProducerHandle | undefined;
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
      // The route the test provider takes, so a battery that reports its route from this config
      // names the model it actually measured.
      ...testGenerationConfig(DEFAULTS),
    };
    this.config = options.tune === undefined ? shipped : options.tune(shipped);
    this.#certifyJudgments = options.certifyJudgments;
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
    // The producer opening every battery on this substrate generates through: the campaign
    // ledger's guard, carrying whatever lifetime budget the coordinator wrote onto that file,
    // and the durable usage recorder that puts each billed response on the books under this
    // substrate's label and the case in progress. `beginCase` names that case.
    const producer = openCampaignProducer({
      experiment: `gate-${this.label}`,
      ceilingUsd: this.config.anthropic.dailyCeilingUsd,
    });
    this.#producer = producer;
    this.#provider = testGenerationProvider({
      baseUrl: this.config.ollama.url,
      embedModel: this.config.models.embed,
      spending: producer.guard,
      recordApiCall: producer.recordApiCall,
    });
    // The pipeline's narrative stage publishes, and without a coordinator it failed every run:
    // five attempts, then the job exhausted and sat in the queue while `whenIdle()` resolved
    // over it, which is what every "timed out waiting for X to enrich" in this suite was.
    //
    // Built here rather than beside the direct publishers below, because those stand a pairing
    // row up by hand to skip the protocol, and a pairing already marked initialized makes the
    // coordinator report a guard node nothing ever minted.
    const publications = new PublicationCoordinator({
      driver: this.driver,
      db: this.db,
      logger: this.logger,
      handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    });
    await publications.initialize();
    this.#publications = publications;
  }

  async close(): Promise<void> {
    this.#publications = undefined;
    await stopNeo4jHarness(this.#harness);
    this.#harness = undefined;
    this.#db?.close();
    this.#db = undefined;
    this.#producer?.close();
    this.#producer = undefined;
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

  get publications(): PublicationCoordinator {
    if (this.#publications === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#publications;
  }

  get provider(): Provider {
    if (this.#provider === undefined) {
      throw new Error('gate substrate is not open');
    }
    return this.#provider;
  }

  /**
   * Names the case every response recorded after it belongs to, on the campaign ledger. A battery
   * that never calls it still records its usage, under `unnamed-case`.
   */
  beginCase(caseKey: string): void {
    this.#producer?.beginCase(caseKey);
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
      publications: directIntakePublisher(this.driver, this.db),
    };
  }

  /** The seam the service gives a judging stage, or nothing where the battery reads without one. */
  judgmentEvidence(): CoveredJudgmentEvidence | undefined {
    if (this.#certifyJudgments !== true) {
      return undefined;
    }
    return new CoveredJudgmentEvidence({
      db: this.db,
      resolver: new EvidenceResolver({
        driver: this.driver,
        db: this.db,
        logger: this.logger,
        publications: this.publications,
      }),
    });
  }

  /** The shipped stage list, from `bootstrap.ts`, over this substrate. */
  orchestrator(): ReflectionOrchestrator {
    const evidence = this.judgmentEvidence();
    return new ReflectionOrchestrator(
      {
        driver: this.driver,
        db: this.db,
        provider: this.provider,
        logger: this.logger,
        publications: this.publications,
        ...(evidence === undefined ? {} : { evidence }),
      },
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
        publications: directCompletionPublisher(this.driver, this.db),
        resolver: new EvidenceResolver({
          driver: this.driver,
          db: this.db,
          logger: { warn: () => undefined },
        }),
      },
      workerOptions(this.config),
    );
    return this.#worker;
  }

  async store(payload: unknown, options: GateStoreOptions): Promise<ReflectionOutput> {
    const stored = await handleReflection(this.intakeDeps(), payload, {
      identity: options.identity,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    // Intake queues the embedding rather than performing it. Every battery here measures a
    // recall, and a recall over unvectorized episodes measures the fixture rather than the
    // substrate, so the row the worker would run is run here.
    await drainAcceptedVectors(this.driver, this.provider);
    return stored;
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
    return isLedgerApplied(this.db, orchestratorLedgerKey(PIPELINE_VERSION, episodeId));
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
