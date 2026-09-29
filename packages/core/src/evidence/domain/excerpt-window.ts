import { FINGERPRINT_PATTERN } from '../../redaction/fingerprint.js';

/**
 * The window an entity judgment is shown on one captured part.
 *
 * A literal match of a name or alias places the window; it decides nothing about identity. The
 * window keeps whole paragraphs around the match when they fit, and whole sentences when the
 * paragraph does not, because attribution, negation and the referent being discussed usually sit
 * beside the name rather than in it. A part that never spells a name gets its head, labeled as
 * such: extraction resolves pronouns and normalized names, so no literal match is not proof the
 * entity was absent.
 *
 * Offsets are UTF-16 code units into the rendered part and are found on the original text, never
 * on a case-folded copy whose length can differ from it.
 */

export type WindowPlacement =
  { readonly kind: 'literal'; readonly matched: string } | { readonly kind: 'no_literal_match' };

export type ExcerptWindow = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The whole part's length, so a reader can tell a window from the part it came from. */
  readonly partUnits: number;
  readonly placement: WindowPlacement;
};

type Span = { readonly start: number; readonly end: number };

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** The earliest literal occurrence of any name, the longest one where two start together. */
function firstMention(
  text: string,
  names: readonly string[],
): (Span & { readonly matched: string }) | undefined {
  let best: (Span & { readonly matched: string }) | undefined;
  for (const name of names) {
    const literal = name.trim();
    if (literal.length === 0) {
      continue;
    }
    // A run of whitespace in a name matches any run in the text, so a wrapped line still counts.
    const pattern = new RegExp(literal.replace(REGEX_SYNTAX, '\\$&').replace(/\s+/g, '\\s+'), 'iu');
    const match = pattern.exec(text);
    if (match === null) {
      continue;
    }
    const found = { start: match.index, end: match.index + match[0].length, matched: match[0] };
    if (
      best === undefined ||
      found.start < best.start ||
      (found.start === best.start && found.end > best.end)
    ) {
      best = found;
    }
  }
  return best;
}

function paragraphsOf(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (const gap of text.matchAll(/\n[^\S\n]*\n\s*/g)) {
    spans.push({ start, end: gap.index });
    start = gap.index + gap[0].length;
  }
  spans.push({ start, end: text.length });
  return spans;
}

function sentencesOf(text: string, within: Span): Span[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const spans: Span[] = [];
  for (const segment of segmenter.segment(text.slice(within.start, within.end))) {
    const start = within.start + segment.index;
    spans.push({ start, end: start + segment.segment.length });
  }
  return spans.length === 0 ? [within] : spans;
}

function holding(blocks: readonly Span[], offset: number): number {
  const index = blocks.findIndex((block) => offset >= block.start && offset < block.end);
  return index === -1 ? blocks.length - 1 : index;
}

/**
 * The blocks holding the anchor, widened one neighbour at a time while the window still fits, or
 * nothing when the holding blocks alone are too long. The following block is tried first: "X is
 * the service. It is not the repo." carries its distinction after the name more often than
 * before it.
 */
function grown(blocks: readonly Span[], anchor: Span, maxUnits: number): Span | undefined {
  let first = holding(blocks, anchor.start);
  let last = holding(blocks, Math.max(anchor.start, anchor.end - 1));
  const startOf = (index: number): number => blocks[index]?.start ?? 0;
  const endOf = (index: number): number => blocks[index]?.end ?? 0;
  if (endOf(last) - startOf(first) > maxUnits) {
    return undefined;
  }
  let widened = true;
  while (widened) {
    widened = false;
    if (last + 1 < blocks.length && endOf(last + 1) - startOf(first) <= maxUnits) {
      last += 1;
      widened = true;
    }
    if (first > 0 && endOf(last) - startOf(first - 1) <= maxUnits) {
      first -= 1;
      widened = true;
    }
  }
  return { start: startOf(first), end: endOf(last) };
}

function centred(text: string, anchor: Span, maxUnits: number): Span {
  const middle = Math.floor((anchor.start + anchor.end) / 2);
  const end = Math.min(text.length, Math.max(0, middle - Math.floor(maxUnits / 2)) + maxUnits);
  return { start: Math.max(0, end - maxUnits), end };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Edges pulled inward so the window never starts or ends inside a surrogate pair or a redaction
 * fingerprint. Half a fingerprint reads as text the capture never held, and it is the one token a
 * reader has to see whole to know a secret was there.
 */
function snapped(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text.charAt(start))) {
    start += 1;
  }
  while (end > start && /\s/.test(text.charAt(end - 1))) {
    end -= 1;
  }
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  for (const token of text.matchAll(new RegExp(FINGERPRINT_PATTERN.source, 'g'))) {
    const tokenEnd = token.index + token[0].length;
    if (token.index < start && start < tokenEnd) {
      start = tokenEnd;
    }
    if (token.index < end && end < tokenEnd) {
      end = token.index;
    }
  }
  return { start, end: Math.max(start, end) };
}

/** Paragraphs around the anchor when they fit, then sentences, then a window centred on it. */
export function windowOn(text: string, names: readonly string[], maxUnits: number): ExcerptWindow {
  const mention = firstMention(text, names);
  const anchor = mention ?? { start: 0, end: 0 };
  const paragraphs = paragraphsOf(text);
  const paragraph = paragraphs[holding(paragraphs, anchor.start)] ?? { start: 0, end: 0 };
  const chosen =
    grown(paragraphs, anchor, maxUnits) ??
    grown(sentencesOf(text, paragraph), anchor, maxUnits) ??
    centred(text, anchor, maxUnits);
  const { start, end } = snapped(text, chosen);
  return {
    text: text.slice(start, end),
    start,
    end,
    partUnits: text.length,
    placement:
      mention === undefined
        ? { kind: 'no_literal_match' }
        : { kind: 'literal', matched: mention.matched },
  };
}
