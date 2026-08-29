import type { Vector } from '../../infrastructure/providers/types.js';
import type { Measurement } from './admission.js';
import { cosineSimilarity } from './ranking.js';

/**
 * Measuring what the spread reached. An activation score says how strongly the graph connects
 * a node to a seed, which is a different question from how well the node answers the query, so
 * a node reached by traversal alone arrives at the gate carrying nothing the gate can read.
 * The cues are embedded by the time the spread runs, so the number the gate needs is one dot
 * product per arrival against vectors the run already holds.
 */

/** A cue as arrival scoring reads it. A cue with no vector measures nothing. */
export type ScoringCue = {
  readonly text: string;
  readonly vector?: Vector;
};

type EmbeddedCue = ScoringCue & { readonly vector: Vector };

export type ArrivalScoringInput = {
  /** Ids the spread reached that no seed strategy found. */
  readonly arrivals: readonly string[];
  /** Content vectors by node id. An id absent from the map carries no vector yet. */
  readonly vectors: ReadonlyMap<string, Vector>;
  readonly cues: readonly ScoringCue[];
};

function embeddedCues(cues: readonly ScoringCue[]): readonly EmbeddedCue[] {
  const embedded: EmbeddedCue[] = [];
  for (const cue of cues) {
    const vector = cue.vector;
    if (vector !== undefined && vector.length > 0) {
      embedded.push({ ...cue, vector });
    }
  }
  return embedded;
}

/**
 * One measurement per arrival and cue, recorded on the vector method: a cosine between a cue
 * and a node's content is the same evidence whichever stage put the pair in front of the gate,
 * and admission is built to read one kind of number. How the node was found stays the
 * rationale's business, and for an arrival that is still activation.
 *
 * An arrival whose content vector is still pending gets no entry at all. That is what keeps
 * "nothing measured it" a different answer from "a measurement fell short" when a thin pack
 * has to explain itself.
 */
export function scoreArrivals(input: ArrivalScoringInput): ReadonlyMap<string, Measurement[]> {
  const measured = new Map<string, Measurement[]>();
  const cues = embeddedCues(input.cues);
  if (cues.length === 0) {
    return measured;
  }

  for (const id of input.arrivals) {
    const vector = input.vectors.get(id);
    if (vector === undefined || vector.length === 0) {
      continue;
    }
    measured.set(
      id,
      cues.map((cue) => ({
        method: 'vector',
        relevance: cosineSimilarity(vector, cue.vector),
        cue: cue.text,
      })),
    );
  }

  return measured;
}
