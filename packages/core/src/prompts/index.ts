/**
 * Every generation system prompt the workspace runs lives in this directory, one file per
 * surface. A surface exports its text under both `LOCAL` and `KEYED`: where the two routes read
 * the same words, both names point at one constant, and `fork-registry.test.ts` proves it. A
 * surface whose modes diverge joins that file's list in the same commit as the fork, so a
 * divergence cannot land unnamed. Parameterized surfaces export builder functions under the same
 * two names. User-message builders stay with the stage that assembles them: they are logic
 * rather than text.
 */

import type { Provider } from '../infrastructure/providers/types.js';

export type PromptMode = 'local' | 'keyed';

/**
 * Which text a call site reads, written once here so no consumer restates the rule. An absent
 * route reads as local, matching how the provider contract treats a test fake or a bare Ollama
 * client.
 */
export function promptMode(provider: Pick<Provider, 'route'>): PromptMode {
  return provider.route?.provider === 'anthropic' ? 'keyed' : 'local';
}
