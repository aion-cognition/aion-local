/** A recorded input cannot support this migration action; the rest of the cohort remains runnable. */
export class MigrationRefused extends Error {
  readonly id: string;
  readonly reason: string;
  constructor(id: string, reason: string) {
    super(`migration refused: ${id}: ${reason}`);
    this.name = 'MigrationRefused';
    this.id = id;
    this.reason = reason;
  }
}
