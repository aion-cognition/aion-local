import { describe, expect, it } from 'vitest';
import { jsonSpans, parseJsonPayload } from './anthropic-client.js';

/**
 * The self-correcting reply is transcribed from a live `claude-haiku-4-5` answer to cognitive
 * extraction at temperature zero: a fenced block naming a type outside the schema's enum, a
 * line of second thoughts, then a corrected block. Both halves of the defect it caused are
 * asserted here, since the parse failure and the invalid enum value are the same reply read
 * two different ways.
 */
const SELF_CORRECTING_REPLY = `\`\`\`json
{
  "nodes": [
    { "type": "Decision", "text": "Move queue writes to a separate SQLite database." },
    { "type": "Problem", "text": "The reflection queue kept deadlocking." }
  ]
}
\`\`\`

Wait, I need to reconsider - "Problem" is not in the allowed enum. Let me revise:

\`\`\`json
{
  "nodes": [
    { "type": "Decision", "text": "Move queue writes to a separate SQLite database." }
  ]
}
\`\`\``;

describe('parsing a structured-output reply', () => {
  it('reads a bare JSON value', () => {
    expect(parseJsonPayload('{"nodes": []}')).toEqual({ nodes: [] });
  });

  it('reads a value wrapped in one code fence', () => {
    expect(parseJsonPayload('```json\n{"nodes": [1]}\n```')).toEqual({ nodes: [1] });
  });

  it('takes the corrected answer when the reply reconsiders itself', () => {
    const parsed = parseJsonPayload(SELF_CORRECTING_REPLY) as { nodes: { type: string }[] };
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes.map((node) => node.type)).toEqual(['Decision']);
  });

  it('reads a value followed by trailing prose', () => {
    expect(parseJsonPayload('{"ok": true}\n\nThat is my answer.')).toEqual({ ok: true });
  });

  it('reads a top-level array', () => {
    expect(parseJsonPayload('Here you go:\n[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('refuses a reply carrying no complete value', () => {
    expect(() => parseJsonPayload('I cannot answer that.')).toThrow(SyntaxError);
    expect(() => parseJsonPayload('{"nodes": [')).toThrow(SyntaxError);
  });

  it('does not treat a brace inside a string as a delimiter', () => {
    expect(parseJsonPayload('{"text": "a } and a { in prose"}')).toEqual({
      text: 'a } and a { in prose',
    });
  });

  it('does not treat an escaped quote as the end of a string', () => {
    expect(parseJsonPayload('{"text": "he said \\"} hi\\" once"}')).toEqual({
      text: 'he said "} hi" once',
    });
  });
});

describe('scanning a reply for complete JSON values', () => {
  it('reports one span per top-level value and none for the nesting inside them', () => {
    const spans = jsonSpans('{"a": {"b": 1}} then [2] then {"c": 3}');
    expect(spans).toHaveLength(3);
  });

  it('reports nothing for an unclosed value', () => {
    expect(jsonSpans('{"a": [1, 2')).toEqual([]);
  });
});
