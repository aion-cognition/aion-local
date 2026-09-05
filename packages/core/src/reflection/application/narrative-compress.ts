import type { NarrativeDeps, NarrativeSettings } from './narratives.js';
import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import {
  assembleChunkedNarrative,
  narrativeChunks,
  renderChunkSource,
  type NarrativeChunkResult,
} from '../domain/narrative-chunks.js';
import {
  assembleNarrative,
  buildNarrativeMessages,
  groundSentences,
  narrativeMaxTokens,
  NARRATIVE_JSON_SCHEMA,
  NarrativeOutputSchema,
  renderNarrativeSource,
  type GroundedNarrative,
  type NarrativeEpisode,
  type NarrativeExtractedNode,
  type NarrativeOutput,
  type NarrativeSource,
} from '../domain/narrative.js';

/**
 * The model calls a session narrative is written by, in the two shapes a session comes in: one
 * call over a session that fits the window, and one call per chunk plus a final call over the
 * chunk texts for a session that does not. Split from the decision path beside it so each file
 * stays inside the module ceiling; nothing here decides whether to narrate.
 */

/**
 * Named rather than left to the route's default, which the provider no longer sends. The
 * compression is a reading of episodes that are already closed, and the grounding check that
 * follows measures one narrative rather than a fresh sample of it.
 */
const NARRATIVE_TEMPERATURE = 0;

/** The answer and the source it was written from, which is what the write records about it. */
export type Synthesis = {
  readonly output: GroundedNarrative;
  readonly source: NarrativeSource;
};

/**
 * One structured-output call, guarded. Reflection's latency regime is relaxed, not unbounded:
 * `qwen3:8b` with reasoning on measured 10-44s with occasional non-returns, so reasoning is off
 * and every call carries its own deadline rather than relying on the orchestrator, which imposes
 * none. The token ceiling tracks the source's own sentence budget: a fixed one is what a thin
 * session pads with invention.
 */
async function generateNarrative(
  deps: NarrativeDeps,
  settings: NarrativeSettings,
  source: NarrativeSource,
): Promise<NarrativeOutput> {
  const deadline = deadlineFor(settings.timeoutMs, settings.signal);
  try {
    const raw = await deps.provider.generate({
      model: settings.model,
      messages: buildNarrativeMessages(source),
      schema: NARRATIVE_JSON_SCHEMA,
      maxTokens: narrativeMaxTokens(source.sentenceBudget),
      temperature: NARRATIVE_TEMPERATURE,
      think: false,
      signal: deadline.signal,
    });
    return NarrativeOutputSchema.parse(raw);
  } finally {
    deadline.clear();
  }
}

/**
 * A session past the window, read in full: one call per chunk, then one over the chunk texts.
 * The cost is `ceil(n / cap) + 1` calls where a session inside the window pays one, and each
 * call carries its own deadline. A chunk that grounded nothing has no text to offer, so it does
 * not reach the final call and the ids it read are not citable there.
 */
async function compressChunks(
  deps: NarrativeDeps,
  settings: NarrativeSettings,
  episodes: readonly NarrativeEpisode[],
  extracted: readonly NarrativeExtractedNode[],
  chunks: readonly (readonly NarrativeEpisode[])[],
): Promise<Synthesis> {
  const written: NarrativeChunkResult[] = [];
  let dropped = 0;

  for (const chunk of chunks) {
    const chunkSource = renderNarrativeSource(
      chunk,
      extracted,
      settings.maxSourceEpisodes,
      settings.maxEpisodeChars,
      settings.maxSentences,
    );
    const grounded = groundSentences(
      await generateNarrative(deps, settings, chunkSource),
      chunkSource,
    );
    const text = grounded.sentences.map((sentence) => sentence.text).join(' ');
    dropped += grounded.dropped;
    if (text.length > 0) {
      written.push({ text, citations: grounded.citations });
    }
  }

  const source = renderChunkSource(written, episodes.length, settings.maxSentences);
  if (written.length === 0) {
    return { source, output: { summary: '', narrative: '', citations: [], kept: 0, dropped } };
  }

  const output = assembleChunkedNarrative(
    await generateNarrative(deps, settings, source),
    source,
    written,
  );
  return { source, output: { ...output, dropped: output.dropped + dropped } };
}

/**
 * The compression, and the one place a session's length changes the shape of it. A session
 * inside the window is one call over its own episodes, which is what every session was before
 * chunking; past the window the opening is read rather than clipped, and the coverage the write
 * records says so.
 */
export async function compress(
  deps: NarrativeDeps,
  settings: NarrativeSettings,
  episodes: readonly NarrativeEpisode[],
  extracted: readonly NarrativeExtractedNode[],
): Promise<Synthesis> {
  const chunks = narrativeChunks(episodes, settings.maxSourceEpisodes);
  if (chunks.length > 1) {
    return compressChunks(deps, settings, episodes, extracted, chunks);
  }

  const source = renderNarrativeSource(
    episodes,
    extracted,
    settings.maxSourceEpisodes,
    settings.maxEpisodeChars,
    settings.maxSentences,
  );
  return {
    source,
    output: assembleNarrative(await generateNarrative(deps, settings, source), source),
  };
}
