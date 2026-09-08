export class PublicationUnavailable extends Error {
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

export class PublicationPendingError extends PublicationUnavailable {
  constructor(operationId: string, cause: unknown) {
    super('pending_recovery', operationId, { cause });
    this.name = 'PublicationPendingError';
  }
}
