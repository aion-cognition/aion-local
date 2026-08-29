import type { IntrospectionOperation } from '../domain/operation.js';
import { memoryDecayOperation, reinforcementFlushOperation } from './plasticity-operations.js';

/**
 * The registration seam: the one list the service hands the engine. An operation joins
 * maintenance by being constructed here and nowhere else, so what the loop can run is
 * readable in a single function instead of assembled across a wiring file.
 *
 * Order is documentation, not priority. Selection is by tier and urgency, and ties break on
 * waiting time and then on name, so moving a line here changes nothing about what runs.
 */
export function introspectionOperations(): readonly IntrospectionOperation[] {
  return [reinforcementFlushOperation(), memoryDecayOperation()];
}
