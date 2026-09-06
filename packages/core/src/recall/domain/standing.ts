import type { Attribution, Standing, StandingKind } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';

/**
 * What kind of statement a memory is, and how far it can be attributed to anyone.
 *
 * The two questions are separate and both are answered from what the substrate stored. Kind
 * comes off the node's label, because the label is what says whether the text was typed by
 * somebody, extracted by a model, or written over other memories. Attribution comes off a
 * confirmation record or off nothing: a retrieval score is a measure of similarity and says
 * nothing about who stands behind a line, so no score reaches this file.
 */

/** Label to kind, first match wins: a Turn carries `Memory` too, and the primary label is the answer. */
const KIND_BY_LABEL: readonly (readonly [string, StandingKind])[] = [
  ['Turn', 'recorded_utterance'],
  ['Episode', 'recorded_session'],
  ['Decision', 'recorded_decision'],
  ['Narrative', 'synthesized'],
  ['Entity', 'stated_description'],
];

/**
 * Everything else is a model's reading of a capture: the eight cognitive types beside Decision
 * plus Bridge. Calling that an interpretation is the point of the field, since a reader who
 * takes it for a quotation is reading an inference as though somebody had said it.
 */
const DEFAULT_KIND: StandingKind = 'extracted_interpretation';

function kindFor(labels: readonly string[]): StandingKind {
  for (const [label, kind] of KIND_BY_LABEL) {
    if (labels.includes(label)) {
      return kind;
    }
  }
  return DEFAULT_KIND;
}

/**
 * A recorded role is a transport label the calling client chose. Agent-to-agent traffic arrives
 * under `user` like anything else, so the role establishes that something was said and never
 * who said it: it comes back as `reported`, with the role printed verbatim beside it so the
 * reader can weigh it. `attributed` needs a confirmation record naming a confirmer and citing
 * where the confirmation is written down.
 */
function attributionFor(role: string | undefined, confirmed: boolean): Attribution {
  if (confirmed) {
    return 'attributed';
  }
  return role === undefined ? 'unknown' : 'reported';
}

export function standingFor(item: FusedItem, provenance?: ItemProvenance): Standing {
  const confirmation = provenance?.confirmation;
  const role = provenance?.recordedRole;
  return {
    kind: kindFor(item.labels),
    ...(role === undefined ? {} : { recorded_role: role }),
    attribution: attributionFor(role, confirmation !== undefined),
    ...(confirmation === undefined
      ? {}
      : {
          confirmed: {
            by: confirmation.by,
            at: confirmation.at.toISOString(),
            evidence: confirmation.evidence,
          },
        }),
  };
}
