import {
  groundSentences,
  narrativeSentenceBudget,
  renderItem,
  type GroundedNarrative,
  type NarrativeEpisode,
  type NarrativeOutput,
  type NarrativeSource,
  type NarrativeSourceItem,
} from './narrative.js';

/**
 * Reading a session one call cannot hold. The episodes past the window were dropped from the
 * narrative before this existed; here they are read in consecutive chunks and the chunk texts
 * are compressed once more. Everything is pure: the split is a function of the episode set and
 * the cap, and the fold is a function of the answer and the chunks it was given, so a re-run
 * over the same session reads the same pieces and resolves the same ids.
 */

/** How the final pass hears a chunk: one narrative already written, not the episodes behind it. */
const CHUNK_KIND = 'passage';

/**
 * Consecutive runs, none longer than the cap, sized as evenly as the set divides. Even runs
 * rather than full ones first: a trailing chunk holding one episode would weigh as much in the
 * final pass as a full one. A set at or under the cap is one chunk, which is the path that
 * behaves as it did before chunking, and a cap below one cannot split anything.
 */
export function narrativeChunks(
  episodes: readonly NarrativeEpisode[],
  maxEpisodes: number,
): readonly (readonly NarrativeEpisode[])[] {
  if (maxEpisodes < 1 || episodes.length <= maxEpisodes) {
    return [episodes];
  }

  const count = Math.ceil(episodes.length / maxEpisodes);
  const size = Math.floor(episodes.length / count);
  const wide = episodes.length % count;
  const chunks: (readonly NarrativeEpisode[])[] = [];
  let start = 0;

  for (let index = 0; index < count; index += 1) {
    const end = start + size + (index < wide ? 1 : 0);
    chunks.push(episodes.slice(start, end));
    start = end;
  }

  return chunks;
}

/** One chunk's synthesis: the text it grounded, and the graph ids that text cited. */
export type NarrativeChunkResult = {
  readonly text: string;
  readonly citations: readonly string[];
};

/** A chunk is no node, so its position in the list is the tag it answers to. */
function chunkHandle(index: number): string {
  return `S${String(index + 1)}`;
}

/**
 * The final pass reads one item per chunk, in session order, through the same prompt and the
 * same grounding filter one call over the episodes runs on. `renderedCount` and `coverage`
 * describe the session rather than the chunks, because this is the source the stored narrative
 * records and every episode was read by the chunk that held it.
 */
export function renderChunkSource(
  chunks: readonly NarrativeChunkResult[],
  episodeCount: number,
  maxSentences: number,
): NarrativeSource {
  const items: NarrativeSourceItem[] = chunks.map((chunk, index) => ({
    handle: chunkHandle(index),
    // The tag stands in for the graph id an episode item carries. `assembleChunkedNarrative` is
    // what turns a cited tag back into the ids that chunk cited.
    id: chunkHandle(index),
    kind: CHUNK_KIND,
    text: chunk.text,
  }));

  return {
    text: items.map(renderItem).join('\n\n'),
    items,
    renderedCount: episodeCount,
    coverage: 1,
    sentenceBudget: narrativeSentenceBudget(items, maxSentences),
  };
}

/**
 * The final narrative, its citations resolved back through the chunks. A cited tag stands for
 * the ids that chunk's own sentences cited, so the final pass can never cite an episode its
 * chunk left out. Takes the list `renderChunkSource` rendered: a tag resolves by position.
 */
export function assembleChunkedNarrative(
  output: NarrativeOutput,
  source: NarrativeSource,
  chunks: readonly NarrativeChunkResult[],
): GroundedNarrative {
  const grounded = groundSentences(output, source);
  const byHandle = new Map(chunks.map((chunk, index) => [chunkHandle(index), chunk.citations]));
  const citations: string[] = [];

  for (const handle of grounded.citations) {
    for (const id of byHandle.get(handle) ?? []) {
      if (!citations.includes(id)) {
        citations.push(id);
      }
    }
  }

  const kept = grounded.sentences.map((sentence) => sentence.text);
  return {
    summary: kept[0] ?? '',
    narrative: kept.join(' '),
    citations,
    kept: kept.length,
    dropped: grounded.dropped,
  };
}
