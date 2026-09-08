import type { PublicationCoordinator } from './coordinator.js';
import { backoffDelayMs } from '../backoff.js';
import type { Logger } from '../logging/logger.js';

type RecoveryTarget = Pick<PublicationCoordinator, 'hasPending' | 'recover'>;
export type PublicationRecoveryOptions = {
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
};

/** One shared recovery loop, independent of whether any fresh domain work is eligible. */
export class PublicationRecoveryLoop {
  readonly #coordinator: RecoveryTarget;
  readonly #logger: Pick<Logger, 'warn'>;
  readonly #options: PublicationRecoveryOptions;
  #active = false;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #failures = 0;

  constructor(
    coordinator: RecoveryTarget,
    logger: Pick<Logger, 'warn'>,
    options: PublicationRecoveryOptions,
  ) {
    if (
      !Number.isSafeInteger(options.retryBaseMs) ||
      options.retryBaseMs <= 0 ||
      !Number.isSafeInteger(options.retryCapMs) ||
      options.retryCapMs < options.retryBaseMs
    ) {
      throw new Error('publication recovery bounds are invalid');
    }
    this.#coordinator = coordinator;
    this.#logger = logger;
    this.#options = options;
  }

  start(): void {
    if (this.#active) {
      return;
    }
    this.#active = true;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#active = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const running = this.#attempt();
      this.#running = running;
      void running.finally(() => {
        this.#running = undefined;
        if (this.#active) {
          const { retryBaseMs, retryCapMs } = this.#options;
          this.#schedule(
            this.#failures === 0
              ? retryBaseMs
              : backoffDelayMs(this.#failures, retryBaseMs, retryCapMs),
          );
        }
      });
    }, delay);
    this.#timer.unref();
  }

  async #attempt(): Promise<void> {
    try {
      if (this.#coordinator.hasPending()) {
        await this.#coordinator.recover();
      }
      this.#failures = 0;
    } catch (err) {
      this.#failures += 1;
      this.#logger.warn({ err, attempts: this.#failures }, 'publication recovery remains pending');
    }
  }
}
