import type { ReflectionResult } from '@aion/protocol';

import { ReflectionPreBirthRefusedError } from './errors.js';
import {
  handleReflection,
  type ReflectionIntakeDeps,
  type ReflectionIntakeOptions,
} from './intake.js';

/**
 * The tool-facing crossing to the wire. `handleReflection` keeps its own narrow, always-stored
 * return shape for the pipeline's many other callers; this is the one seam that also has to
 * answer for a push the birth fence refused outright, the same way `recallResultFor` answers
 * for a coverage refusal beside `handleRecall`'s own plain `MemoryPack`.
 */
export async function handleReflectionResult(
  deps: ReflectionIntakeDeps,
  input: unknown,
  options: ReflectionIntakeOptions,
): Promise<ReflectionResult> {
  try {
    return await handleReflection(deps, input, options);
  } catch (err) {
    if (err instanceof ReflectionPreBirthRefusedError) {
      return {
        status: 'pre_birth_refusal',
        substrate_born_at: err.substrateBornAt.toISOString(),
        pre_birth_refused: { turns: err.refusedTurns, tool_executions: err.refusedToolExecutions },
      };
    }
    throw err;
  }
}
