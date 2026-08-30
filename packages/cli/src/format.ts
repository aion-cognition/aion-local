/** The three shapes every command renders values in, so two listings never disagree on one. */

/** `12s` / `4m` / `1h`: one unit and no decimals, because these are read at a glance. */
export function ageOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${String(seconds)}s`;
  }
  if (seconds < 7200) {
    return `${String(Math.round(seconds / 60))}m`;
  }
  return `${String(Math.round(seconds / 3600))}h`;
}

/** Short enough to read in a list, long enough to paste back as an unambiguous id prefix. */
export function short(id: string): string {
  return id.slice(0, 8);
}

/** One line of a node's content, whitespace flattened, with the cut marked where it happens. */
export function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
