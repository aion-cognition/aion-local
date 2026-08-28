import { describe, expect, it } from 'vitest';
import { OllamaProvider } from './ollama-provider.js';
import { checkOllamaReachable } from './provisioning.js';

const BASE_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIMENSION = 768;
const CHAT_MODEL = 'qwen3:1.7b';

describe('provisioning against live host Ollama', () => {
  it('confirms reachability, round-trips an embed call, and chat-verifies when the model is present', async () => {
    await expect(checkOllamaReachable(BASE_URL)).resolves.toBeUndefined();

    const provider = new OllamaProvider({ baseUrl: BASE_URL, embedModel: EMBED_MODEL });
    const [vector] = await provider.embed(['aion-local P0-4 integration check']);
    expect(vector).toHaveLength(EMBED_DIMENSION);

    const tagsResponse = await fetch(`${BASE_URL}/api/tags`);
    const tags = (await tagsResponse.json()) as { models?: { name: string }[] };
    const chatModelPresent = tags.models?.some((m) => m.name === CHAT_MODEL) ?? false;

    if (!chatModelPresent) {
      // qwen3:1.7b may still be pulling in the background on this machine (see task handoff).
      console.info(`[provisioning.int] skipping chat round-trip: ${CHAT_MODEL} not yet pulled`);
      return;
    }

    const chatResponse = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'reply with one word' }],
        stream: false,
        options: { num_predict: 5 },
      }),
    });
    expect(chatResponse.ok).toBe(true);

    const chatBody = (await chatResponse.json()) as { done?: boolean; message?: unknown };
    expect(chatBody.done).toBe(true);
    expect(chatBody.message).toBeDefined();
  });
});
