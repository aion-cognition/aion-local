import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import { ModelPullError } from './errors.js';
import { provisionOllama, type OllamaProvisionTarget, type ProvisionEvent } from './provisioning.js';

/** The models come from the config defaults, so a default change is exercised here too. */
const TARGET: OllamaProvisionTarget = {
  baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  embedModel: DEFAULTS.models.embed,
  embedDimension: DEFAULTS.models.embedDimension,
  chatModels: [DEFAULTS.models.cue, DEFAULTS.models.reflect],
};

const [CUE_MODEL, REFLECT_MODEL] = TARGET.chatModels;

function collect(events: readonly ProvisionEvent[], type: ProvisionEvent['type']): string[] {
  return events.flatMap((event) => {
    if (event.type !== type) {
      return [];
    }
    if (event.type === 'verify_done') {
      return [`${event.model}:${event.kind}`];
    }
    return event.type === 'reachable' ? ['reachable'] : [event.model];
  });
}

describe('provisionOllama against live host Ollama', () => {
  it(
    'streams a pull and a round-trip verification for every configured model',
    async () => {
      const events: ProvisionEvent[] = [];

      await expect(
        provisionOllama(TARGET, { onEvent: (event) => events.push(event) }),
      ).resolves.toBeUndefined();

      expect(events[0]).toEqual({ type: 'reachable' });
      expect(collect(events, 'pull_done')).toEqual([TARGET.embedModel, CUE_MODEL, REFLECT_MODEL]);
      expect(collect(events, 'pull_progress').length).toBeGreaterThan(0);
      expect(collect(events, 'verify_done')).toEqual([
        `${TARGET.embedModel}:embed`,
        `${String(CUE_MODEL)}:chat`,
        `${String(REFLECT_MODEL)}:chat`,
      ]);
    },
    600_000,
  );

  it(
    'names the model when a pull cannot be satisfied',
    async () => {
      await expect(
        provisionOllama({ ...TARGET, embedModel: 'aion-no-such-model:v0' }),
      ).rejects.toBeInstanceOf(ModelPullError);
    },
    120_000,
  );
});
