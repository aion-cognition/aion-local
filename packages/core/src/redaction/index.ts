/** The redaction layer's public surface. Deterministic by design, and the one exception to
 * the no-heuristics rule. */

export { DEFAULT_ENTROPY_THRESHOLD, redact } from './redact.js';
export type { RedactionMatch, RedactionResult } from './redact.js';
export { redactPayload } from './deep-walk.js';
export type { DeepRedactionResult } from './deep-walk.js';
export { HIGH_ENTROPY_RULE_ID, REDACTION_RULES, REDACTION_RULE_IDS } from './rules.js';
export type { RedactionRule } from './rules.js';
export { buildFingerprint } from './fingerprint.js';
export { findHighEntropyTokens, shannonEntropy } from './entropy.js';
export type { TextSpan } from './entropy.js';

export { DEFAULT_RESIDUE_SCAN_LIMIT, scanRedactionResidue } from './residue.js';
export type { RedactionResidue } from './residue.js';
