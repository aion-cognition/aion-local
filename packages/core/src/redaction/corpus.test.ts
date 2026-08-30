import { describe, expect, it } from 'vitest';

import { redactPayload } from './deep-walk.js';
import { buildFingerprint } from './fingerprint.js';
import {
  ENV_DUMP_VALUE,
  LEAKED_SHAPES,
  SURVIVING_FIELDS,
  SURVIVING_TEXT,
} from './test-support/leaked-shapes.fixture.js';

describe('redaction corpus: shapes that reached storage as plaintext', () => {
  for (const shape of LEAKED_SHAPES) {
    it(`fingerprints ${shape.label}`, () => {
      const result = redactPayload(shape.payload);
      const serialized = JSON.stringify(result.value);

      expect(serialized).not.toContain(shape.material);
      expect(serialized).toContain(buildFingerprint(shape.rule, shape.material));
      expect(result.matches.map((match) => match.rule)).toContain(shape.rule);
    });
  }

  it('gives one secret one fingerprint whatever case the key beside it was written in', () => {
    const upper = redactPayload({ observations: [`AWS_ACCESS_KEY_ID=${ENV_DUMP_VALUE}`] });
    const lower = redactPayload({ observations: [`aws_access_key_id=${ENV_DUMP_VALUE}`] });

    expect(upper.matches).toEqual(lower.matches);
    expect(upper.value.observations[0]).toBe(`AWS_ACCESS_KEY_ID=${upper.matches[0]?.fingerprint}`);
    expect(lower.value.observations[0]).toBe(`aws_access_key_id=${lower.matches[0]?.fingerprint}`);
  });
});

describe('redaction corpus: material that must survive untouched', () => {
  for (const [label, text] of Object.entries(SURVIVING_TEXT)) {
    it(`leaves ${label} alone`, () => {
      const result = redactPayload({ observations: [text] });

      expect(result.value.observations[0]).toBe(text);
      expect(result.matches).toEqual([]);
    });
  }

  for (const field of SURVIVING_FIELDS) {
    it(`leaves \`${field.key}\` = \`${field.value}\` alone`, () => {
      const result = redactPayload({
        tool_executions: [
          { tool: 'read_file', status: 'ok', output: { [field.key]: field.value } },
        ],
      });

      expect(JSON.stringify(result.value)).toContain(JSON.stringify(field.value).slice(1, -1));
      expect(result.matches).toEqual([]);
    });
  }
});
