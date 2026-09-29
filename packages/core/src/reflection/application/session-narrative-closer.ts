import { NARRATIVE_SESSION_MISSING } from './family-selection.js';
import {
  closeSessionNarrative,
  type NarrativeDeps,
  type SessionNarrativeOptions,
} from './narratives.js';

/** Queues transport closes so a disconnect burst does not run concurrent model calls. */
export class SessionNarrativeCloser {
  readonly #deps: NarrativeDeps;
  readonly #options: SessionNarrativeOptions;
  /** Chained so `whenIdle()` waits for every close scheduled so far, not just the latest. */
  #pending: Promise<void> = Promise.resolve();

  constructor(deps: NarrativeDeps, options: SessionNarrativeOptions = {}) {
    this.#deps = deps;
    this.#options = options;
  }

  /** Bound as a class field so it can be assigned directly to the service's `onSessionClosed`. */
  readonly onSessionClosed = (sessionId: string): void => {
    this.#pending = this.#pending.then(async () => {
      try {
        const result = await closeSessionNarrative(this.#deps, sessionId, this.#options);
        // `narrateSession` fails closed by returning rather than throwing, so the catch below
        // never sees a refusal. Dropping the result made an entirely uncomposed narrative half
        // silent at every log level, and the only symptom was a session that never narrated.
        // A session that never created a Session node, one that only recalled, has nothing to
        // narrate. That is debug; any other refusal is a real failure and stays a warning.
        if (result.status === 'failed') {
          const level = result.summary === NARRATIVE_SESSION_MISSING ? 'debug' : 'warn';
          this.#deps.logger[level](
            { sessionId, summary: result.summary },
            'session close narrative did not write',
          );
        }
      } catch (err) {
        this.#deps.logger.error({ err, sessionId }, 'session close narrative failed');
      }
    });
  };

  /**
   * Resolves once every close scheduled so far has settled. Shutdown awaits this chain, and
   * each entry in it is a model call bounded only by `timeoutMs`, so a process closing many
   * sessions at once can sit here for that timeout per session before it exits.
   */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }
}
