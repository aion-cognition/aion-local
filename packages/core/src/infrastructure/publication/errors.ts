import { isRetryableError } from 'neo4j-driver';

export class PublicationUnavailable extends Error {
  readonly retryable: boolean = false;
  readonly reason: string;
  readonly operationId?: string;
  constructor(reason: string, operationId?: string, options?: ErrorOptions) {
    super(`publication unavailable: ${reason}`, options);
    this.reason = reason;
    if (operationId !== undefined) {
      this.operationId = operationId;
    }
    this.name = 'PublicationUnavailable';
  }
}

export class PublicationInvariantError extends PublicationUnavailable {
  constructor(reason: string, operationId?: string) {
    super(reason, operationId);
    this.name = 'PublicationInvariantError';
  }
}

export class PublicationRetryableError extends PublicationUnavailable {
  override readonly retryable: boolean = true;
  constructor(reason: string, operationId?: string, options?: ErrorOptions) {
    super(reason, operationId, options);
    this.name = 'PublicationRetryableError';
  }
}

export class PublicationPendingError extends PublicationRetryableError {
  constructor(operationId: string, cause: unknown) {
    super('pending_recovery', operationId, { cause });
    this.name = 'PublicationPendingError';
  }
}

/** Keep the native diagnostic as the cause; only recognized transient store failures invite retry. */
export function publicationFailure(error: unknown, operationId?: string): PublicationUnavailable {
  if (error instanceof PublicationUnavailable) {
    return error;
  }
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED')) {
    return new PublicationRetryableError('store_busy', operationId, { cause: error });
  }
  // Neo4j reports an expired lock wait as a ClientError even though a fresh transaction can retry it.
  if (
    isRetryableError(error) ||
    code === 'Neo.ClientError.Transaction.LockClientStopped' ||
    code === 'Neo.ClientError.Transaction.TransactionTimedOut' ||
    code === 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration'
  ) {
    return new PublicationRetryableError('store_unavailable', operationId, { cause: error });
  }
  return new PublicationUnavailable('publication_failed', operationId, { cause: error });
}
