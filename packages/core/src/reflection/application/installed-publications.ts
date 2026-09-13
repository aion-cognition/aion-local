import { reflectionCompletionPublication } from './completion-publication.js';
import { contextVectorSyncPublication } from './context-vector-sync.js';
import { derivedNodeEvidencePublication } from './derived-node-evidence.js';
import { episodeEvictionPublication } from './episode-eviction.js';
import { familySelectionPublication } from './family-selection.js';
import { intakePublication } from './intake-publication.js';
import { claimMergePublication } from './merge-publication.js';
import { narrativePublication } from './narrative-publication.js';
import { narrativeFamilyRepairPublication } from './narrative-repair.js';
import { overviewPublication } from './overview-publication.js';
import { projectionRebuildPublication } from './rebuild-publication.js';
import { statedReferencesPublication } from './reference-publication.js';
import { sourceSuppressionPublication } from './source-suppression.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationHandler } from '../../infrastructure/publication/types.js';
import { orphanSuppressionPublication } from '../../introspection/application/operations/orphan-suppression.js';

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
  claimMergePublication,
  familySelectionPublication,
  narrativePublication,
  narrativeFamilyRepairPublication,
  overviewPublication,
  orphanSuppressionPublication,
  sourceSuppressionPublication,
  episodeEvictionPublication,
  // Reached from three passes, which is the reason it exists: reflection's last stage, the
  // staleness scan and the survivor repair all recompute the same served property, and a
  // process composing a smaller set would meet one of them pending and refuse.
  contextVectorSyncPublication,
  // Reached from the two extraction stages, which are the only callers that can say what they
  // wrote. Installed here like any other so a process that meets one pending can recover it.
  derivedNodeEvidencePublication,
];
