import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as claimDedupJudge from './claim-dedup-judge.js';
import * as cognitiveExtraction from './cognitive-extraction.js';
import * as cognitiveRestatement from './cognitive-restatement.js';
import * as consolidationSynthesis from './consolidation-synthesis.js';
import * as cueExtraction from './cue-extraction.js';
import * as curiosity from './curiosity.js';
import * as descriptionFreshness from './description-freshness.js';
import * as entityExtraction from './entity-extraction.js';
import * as entityMergeJudge from './entity-merge-judge.js';
import { promptMode } from './index.js';
import * as narrativeSynthesis from './narrative-synthesis.js';
import * as proposalHygieneJudge from './proposal-hygiene-judge.js';
import * as semanticRelationships from './semantic-relationships.js';
import * as supersessionJudge from './supersession-judge.js';
import * as supersessionReview from './supersession-review.js';
import * as symbiosisBridge from './symbiosis-bridge.js';
import * as tier3Advisor from './tier3-advisor.js';

/**
 * The fork registry is this list. A surface whose routes read different text is named here;
 * every surface that is not proves its two names are one constant. Forking a surface without
 * naming it here would ship a second text nothing compares against, which is how a keyed prompt
 * drifts away from the local one unseen.
 */
const FORKED: readonly string[] = [];

type SurfacePrompt = {
  readonly surface: string;
  readonly prompt: string;
  readonly local: unknown;
  readonly keyed: unknown;
};

const PROMPTS: readonly SurfacePrompt[] = [
  {
    surface: 'claim-dedup-judge',
    prompt: 'detect',
    local: claimDedupJudge.DETECT_LOCAL,
    keyed: claimDedupJudge.DETECT_KEYED,
  },
  {
    surface: 'claim-dedup-judge',
    prompt: 'review',
    local: claimDedupJudge.REVIEW_LOCAL,
    keyed: claimDedupJudge.REVIEW_KEYED,
  },
  {
    surface: 'cognitive-extraction',
    prompt: 'extraction',
    local: cognitiveExtraction.LOCAL,
    keyed: cognitiveExtraction.KEYED,
  },
  {
    surface: 'cognitive-restatement',
    prompt: 'restatement',
    local: cognitiveRestatement.LOCAL,
    keyed: cognitiveRestatement.KEYED,
  },
  {
    surface: 'consolidation-synthesis',
    prompt: 'rollup',
    local: consolidationSynthesis.ROLLUP_LOCAL,
    keyed: consolidationSynthesis.ROLLUP_KEYED,
  },
  {
    surface: 'consolidation-synthesis',
    prompt: 'subject',
    local: consolidationSynthesis.SUBJECT_LOCAL,
    keyed: consolidationSynthesis.SUBJECT_KEYED,
  },
  {
    surface: 'consolidation-synthesis',
    prompt: 'review',
    local: consolidationSynthesis.REVIEW_LOCAL,
    keyed: consolidationSynthesis.REVIEW_KEYED,
  },
  {
    surface: 'cue-extraction',
    prompt: 'cues',
    local: cueExtraction.LOCAL,
    keyed: cueExtraction.KEYED,
  },
  { surface: 'curiosity', prompt: 'question', local: curiosity.LOCAL, keyed: curiosity.KEYED },
  {
    surface: 'description-freshness',
    prompt: 'freshness',
    local: descriptionFreshness.LOCAL,
    keyed: descriptionFreshness.KEYED,
  },
  {
    surface: 'entity-extraction',
    prompt: 'extraction',
    local: entityExtraction.LOCAL,
    keyed: entityExtraction.KEYED,
  },
  {
    surface: 'entity-extraction',
    prompt: 'refinement',
    local: entityExtraction.REFINEMENT_LOCAL,
    keyed: entityExtraction.REFINEMENT_KEYED,
  },
  {
    surface: 'entity-merge-judge',
    prompt: 'detect',
    local: entityMergeJudge.DETECT_LOCAL,
    keyed: entityMergeJudge.DETECT_KEYED,
  },
  {
    surface: 'entity-merge-judge',
    prompt: 'review',
    local: entityMergeJudge.REVIEW_LOCAL,
    keyed: entityMergeJudge.REVIEW_KEYED,
  },
  {
    surface: 'narrative-synthesis',
    prompt: 'session',
    local: narrativeSynthesis.LOCAL,
    keyed: narrativeSynthesis.KEYED,
  },
  {
    surface: 'proposal-hygiene-judge',
    prompt: 'hygiene',
    local: proposalHygieneJudge.LOCAL,
    keyed: proposalHygieneJudge.KEYED,
  },
  {
    surface: 'semantic-relationships',
    prompt: 'relationships',
    local: semanticRelationships.LOCAL,
    keyed: semanticRelationships.KEYED,
  },
  {
    surface: 'supersession-judge',
    prompt: 'judge',
    local: supersessionJudge.LOCAL,
    keyed: supersessionJudge.KEYED,
  },
  {
    surface: 'supersession-review',
    prompt: 'review',
    local: supersessionReview.LOCAL,
    keyed: supersessionReview.KEYED,
  },
  {
    surface: 'symbiosis-bridge',
    prompt: 'bridge',
    local: symbiosisBridge.LOCAL,
    keyed: symbiosisBridge.KEYED,
  },
  {
    surface: 'tier3-advisor',
    prompt: 'advice',
    local: tier3Advisor.ADVICE_LOCAL,
    keyed: tier3Advisor.ADVICE_KEYED,
  },
  {
    surface: 'tier3-advisor',
    prompt: 'review',
    local: tier3Advisor.REVIEW_LOCAL,
    keyed: tier3Advisor.REVIEW_KEYED,
  },
];

const HERE = fileURLToPath(new URL('.', import.meta.url));

function surfaceFiles(): readonly string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts')
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
}

function named(surface: string): readonly SurfacePrompt[] {
  return PROMPTS.filter((entry) => entry.surface === surface);
}

describe('the prompt fork registry', () => {
  it('carries every surface file in the directory', () => {
    const listed = [...new Set(PROMPTS.map((entry) => entry.surface))].sort();
    expect(listed).toEqual(surfaceFiles());
  });

  it('reads the directory rather than an empty one', () => {
    expect(surfaceFiles().length).toBe(16);
  });

  it('ships one text for both routes on every surface off the list', () => {
    const diverged = PROMPTS.filter(
      (entry) => !FORKED.includes(entry.surface) && entry.local !== entry.keyed,
    ).map((entry) => `${entry.surface}: ${entry.prompt}`);
    expect(diverged).toEqual([]);
  });

  it('lists only surfaces whose routes really do differ', () => {
    const stale = FORKED.filter((surface) =>
      named(surface).every((entry) => entry.local === entry.keyed),
    );
    expect(stale).toEqual([]);
  });

  it('names only surfaces that exist', () => {
    expect(FORKED.filter((surface) => named(surface).length === 0)).toEqual([]);
  });

  it('catches a divergence the list does not name', () => {
    const planted: SurfacePrompt[] = [
      { surface: 'planted', prompt: 'planted', local: 'one text', keyed: 'another text' },
    ];
    expect(planted.filter((entry) => entry.local !== entry.keyed)).toHaveLength(1);
  });
});

describe('promptMode', () => {
  it('reads the keyed text on the Anthropic route', () => {
    expect(promptMode({ route: { provider: 'anthropic' } })).toBe('keyed');
  });

  it('reads the local text on the Ollama route', () => {
    expect(promptMode({ route: { provider: 'ollama' } })).toBe('local');
  });

  it('reads the local text when a provider states no route', () => {
    expect(promptMode({})).toBe('local');
  });
});
