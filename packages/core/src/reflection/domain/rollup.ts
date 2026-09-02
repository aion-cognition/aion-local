/**
 * The scopes above a session, and the windows they cover. A session narrative is written by the
 * close; a day rolls up the sessions that ended inside it, and a week rolls up those days. All
 * pure: which window a narrative falls in, whether that window has finished, and which members
 * a window holds are decidable without a graph.
 *
 * UTC throughout, for the reason the operation buckets are: two instances in different zones
 * must derive the same window for the same narrative.
 */

export const ROLLUP_SCOPES = ['day', 'week'] as const;

export type RollupScope = (typeof ROLLUP_SCOPES)[number];

/** Which scope a rollup reads. Each scope rolls up exactly the one below it. */
export function rollupMemberScope(scope: RollupScope): string {
  return scope === 'day' ? 'session' : 'day';
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayKey(date: Date): string {
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Monday, because the ISO week the key names starts there. */
function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const weekday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - weekday * DAY_MS);
}

/**
 * The ISO week the date falls in, by the Thursday rule: the week owning a year's first Thursday
 * is week 1, which is what makes the last days of December belong to the next year's week 1
 * rather than to a 53rd week that does not exist.
 */
function isoWeekKey(date: Date): string {
  const thursday = new Date(startOfWeek(date).getTime() + 3 * DAY_MS);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (startOfWeek(thursday).getTime() - startOfWeek(firstThursday).getTime()) / (7 * DAY_MS),
    );
  return `${String(thursday.getUTCFullYear())}-W${pad(week)}`;
}

export type RollupWindowBounds = {
  readonly key: string;
  readonly start: Date;
  /** Exclusive: the first instant that belongs to the next window. */
  readonly end: Date;
};

export function rollupWindow(scope: RollupScope, date: Date): RollupWindowBounds {
  if (scope === 'day') {
    const start = startOfDay(date);
    return { key: dayKey(start), start, end: new Date(start.getTime() + DAY_MS) };
  }
  const start = startOfWeek(date);
  return { key: isoWeekKey(start), start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/**
 * A window is rolled up once it can no longer grow. Compressing the window a session is still
 * running in writes a rollup the next session close immediately makes incomplete, which is a
 * version churn nothing reads.
 */
export function isWindowClosed(window: RollupWindowBounds, now: Date): boolean {
  return now.getTime() >= window.end.getTime();
}

export type RollupMember = {
  readonly id: string;
  readonly text: string;
  readonly summary?: string;
  /** World time: the window a narrative belongs to is the window its experience happened in. */
  readonly occurredAt?: Date;
};

export type RollupWindow = RollupWindowBounds & {
  readonly members: readonly RollupMember[];
};

/**
 * Members grouped into the windows they fall in, oldest window first, members inside a window
 * in the order they happened. A member carrying no world time is left out rather than dated to
 * the run: a narrative with no span cannot be placed in a day, and guessing places it in the
 * wrong one.
 */
export function groupRollupWindows(
  members: readonly RollupMember[],
  scope: RollupScope,
): readonly RollupWindow[] {
  const windows = new Map<string, { bounds: RollupWindowBounds; members: RollupMember[] }>();

  for (const member of members) {
    if (member.occurredAt === undefined) {
      continue;
    }
    const bounds = rollupWindow(scope, member.occurredAt);
    const held = windows.get(bounds.key);
    if (held === undefined) {
      windows.set(bounds.key, { bounds, members: [member] });
      continue;
    }
    held.members.push(member);
  }

  return [...windows.values()]
    .map((held) => ({
      ...held.bounds,
      members: [...held.members].sort(
        (left, right) =>
          (left.occurredAt?.getTime() ?? 0) - (right.occurredAt?.getTime() ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());
}
