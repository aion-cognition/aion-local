import type { StructuredRequest } from '../../infrastructure/providers/types.js';

/**
 * The cascade's two-pass judge, scripted by name. `same` answers the detect pass and `review`
 * answers whether the adversarial pass agrees, so a test can make a run unanimous, split, or
 * refusing, per pair. Every request is recorded, which is how a test asserts that a tier decided
 * without asking a model at all.
 *
 * The two passes are told apart by their schemas rather than by call order, since a run judges
 * several pairs and only the affirmative ones reach the second pass.
 */

export type EntityJudgeScript = {
  readonly same?: (left: string, right: string) => boolean;
  readonly review?: (left: string, right: string) => boolean;
};

export type ScriptedEntityJudge = {
  readonly generate: (request: StructuredRequest) => Promise<unknown>;
  readonly calls: StructuredRequest[];
};

/** The two names as the prompt states them, so a script can answer per pair. */
export function judgedNames(request: StructuredRequest): [string, string] {
  const prompt = request.messages.map((message) => message.content).join('\n');
  const names = [...prompt.matchAll(/^Entity [AB]: (.+)$/gm)].map((match) => match[1] ?? '');
  return [names[0] ?? '', names[1] ?? ''];
}

export function scriptedEntityJudge(script: EntityJudgeScript = {}): ScriptedEntityJudge {
  const calls: StructuredRequest[] = [];
  const same = script.same ?? ((): boolean => true);
  const review = script.review ?? ((): boolean => true);
  return {
    calls,
    generate: async (request: StructuredRequest) => {
      calls.push(request);
      const [left, right] = judgedNames(request);
      if (JSON.stringify(request.schema).includes('different_referent')) {
        return { different_referent: !review(left, right), reason: 'scripted review' };
      }
      return { same: same(left, right), rationale: 'scripted detection' };
    },
  };
}

/** Refuses every pair on the first pass, so nothing a judged tier sees can merge. */
export function refusingEntityJudge(): ScriptedEntityJudge {
  return scriptedEntityJudge({ same: () => false });
}

/** Fails the moment anything asks it to generate: proof a tier decided with no model. */
export function unreachableEntityJudge(): ScriptedEntityJudge {
  return {
    calls: [],
    generate: async (): Promise<unknown> => {
      throw new Error('no model call belongs on this path');
    },
  };
}
