import { reflectionCompletionPublication } from './completion-publication.js';
import { intakePublication } from './intake-publication.js';
import { legacyMaterializationPublication } from './legacy-materialization.js';
import { claimMergePublication } from './merge-publication.js';
import { projectionRebuildPublication } from './rebuild-publication.js';
import { statedReferencesPublication } from './reference-publication.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationHandler } from '../../infrastructure/publication/types.js';

/**
 * The one installed handler set, shared by every process that publishes.
 *
 * There is a single receipt, and a writer has to recover whatever operation is occupying it
 * before it can publish its own. A command composing a smaller set therefore cannot start: it
 * meets a pending operation of a kind it does not know and refuses, which is the correct
 * refusal for a genuinely unsupported kind and the wrong one for a kind the service installs.
 * One list is what keeps the two compositions the same deployment.
 *
 * Adding a handler here is what enables its writer. A writer whose kind is absent refuses
 * loudly rather than writing outside the protocol.
 */
export const INSTALLED_PUBLICATION_HANDLERS: readonly PublicationHandler[] = [
  ...PUBLICATION_HANDLERS,
  intakePublication,
  statedReferencesPublication,
  projectionRebuildPublication,
  reflectionCompletionPublication,
  legacyMaterializationPublication,
  claimMergePublication,
];
