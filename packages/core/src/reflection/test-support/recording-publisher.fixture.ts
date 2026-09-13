import type {
  PublicationCoordinator,
  PublicationRequest,
} from '../../infrastructure/publication/coordinator.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';

/**
 * A publish surface that acknowledges whatever it is handed and keeps it.
 *
 * For a stage's own unit tests, which hold a fake graph and no substrate: the stage has to publish
 * what it wrote, and what those tests are about is whether it reported every node rather than what
 * the coordinator does with the report. The requests are kept so a case can assert the payload.
 *
 * It runs no handler and writes nothing. A case whose subject is what a publication leaves behind
 * belongs against real stores.
 */
export class RecordingPublisher {
  readonly requests: PublicationRequest[] = [];

  publish(request: PublicationRequest): Promise<PublicationOutcome> {
    this.requests.push(request);
    return Promise.resolve({
      status: 'acknowledged',
      operationId: request.operationId,
      sequence: String(this.requests.length),
      result: { recorded: 0, preserved: 0, established: 0 },
      knownFrom: '2026-09-13T00:00:00.000Z',
      observedAckAt: '2026-09-13T00:00:00.000Z',
      clockClamped: false,
    });
  }

  /** The payloads of one kind, in the order the caller published them. */
  payloadsOf(kind: string): readonly unknown[] {
    return this.requests
      .filter((request) => request.kind === kind)
      .map((request) => request.payload);
  }

  /** The stage seam takes a coordinator; this is the narrowing that lets a stub stand in one. */
  asCoordinator(): PublicationCoordinator {
    return this as unknown as PublicationCoordinator;
  }
}
