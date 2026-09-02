import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTROPY_THRESHOLD, redact, redactKeyedValue } from './redact.js';
import { DEFAULTS } from '../infrastructure/config/defaults.js';

describe('DEFAULT_ENTROPY_THRESHOLD', () => {
  it('matches the entropyThreshold knob, so the two literals cannot drift apart', () => {
    expect(DEFAULT_ENTROPY_THRESHOLD).toBe(DEFAULTS.redaction.entropyThreshold);
  });
});

describe('redact: true positives, one per rule', () => {
  const cases: { rule: string; secret: string; text: string }[] = [
    {
      rule: 'aws-access-key',
      secret: 'AKIAIOSFODNN7EXAMPLE',
      text: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    },
    {
      rule: 'aws-secret-key',
      secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      text: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    {
      rule: 'github-token',
      secret: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD',
      text: 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD',
    },
    {
      rule: 'github-token',
      secret: 'github_pat_11AAAAAAAA0123456789abcdefghijklmnopqrstuvwxyz',
      text: 'GH_TOKEN=github_pat_11AAAAAAAA0123456789abcdefghijklmnopqrstuvwxyz',
    },
    {
      rule: 'gitlab-token',
      secret: 'glpat-1234567890abcdefWXYZ',
      text: 'CI_JOB_TOKEN=glpat-1234567890abcdefWXYZ',
    },
    {
      rule: 'jwt',
      secret:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
    {
      rule: 'slack-token',
      secret: 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
      text: 'SLACK_BOT_TOKEN=xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
    },
    {
      rule: 'anthropic-api-key',
      secret: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      text: 'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    {
      rule: 'openai-api-key',
      secret: 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      text: 'OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  ];

  for (const { rule, secret, text } of cases) {
    it(`redacts a ${rule} match and drops the raw material`, () => {
      const result = redact(text);
      const match = result.matches.find((m) => m.rule === rule);
      expect(match).toBeDefined();
      expect(result.text).not.toContain(secret);
      expect(result.text).toContain(match?.fingerprint);
    });
  }

  it('redacts a PEM private key block in full', () => {
    const body = 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEr7BPGZbSHKkOtIQjblEvMxWNZlmWv';
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const result = redact(text);
    expect(result.matches.some((m) => m.rule === 'pem-private-key')).toBe(true);
    expect(result.text).not.toContain(body);
    expect(result.text).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('redacts only the embedded credentials in a connection string, keeping host and db', () => {
    const text = 'DATABASE_URL=postgres://dbuser:S3cr3tPass@db.example.com:5432/mydb';
    const result = redact(text);
    const match = result.matches.find((m) => m.rule === 'connection-string');
    expect(match).toBeDefined();
    expect(result.text).not.toContain('dbuser:S3cr3tPass');
    expect(result.text).toContain('postgres://');
    expect(result.text).toContain('@db.example.com:5432/mydb');
  });

  it('redacts a generic key=value secret', () => {
    const text = 'password=Zt7pQ4mX9wL2vR8kY5nB3hC6jF1sD0g';
    const result = redact(text);
    const match = result.matches.find((m) => m.rule === 'generic-secret-assignment');
    expect(match).toBeDefined();
    expect(result.text).not.toContain('Zt7pQ4mX9wL2vR8kY5nB3hC6jF1sD0g');
  });
});

// The 8-22 character band is where most real API keys, DB passwords, and client secrets
// live, and it is unreachable for any entropy threshold above log2(22) = 4.46 bits/char.
describe('redact: short generic secrets, the band an entropy gate cannot reach', () => {
  const cases: { label: string; text: string; secret: string }[] = [
    { label: 'a shell password', text: 'password=hunter2secret', secret: 'hunter2secret' },
    { label: 'a password with symbols', text: 'password: Tr0ub4dor&3', secret: 'Tr0ub4dor&3' },
    { label: 'a quoted api key', text: 'api_key="abcd1234efgh"', secret: 'abcd1234efgh' },
    {
      label: 'a prefixed vendor key',
      text: 'API_KEY=sk_live_51H8xYzAbCdEf',
      secret: 'sk_live_51H8xYzAbCdEf',
    },
    { label: 'a short client secret', text: 'client_secret=shortish123', secret: 'shortish123' },
    { label: 'an eight-character token', text: 'token=abc12345', secret: 'abc12345' },
    {
      label: 'an underscore-prefixed env name',
      text: 'DB_PASSWORD=P@ssw0rd123',
      secret: 'P@ssw0rd123',
    },
    {
      label: 'a spaced assignment',
      text: 'secret = correcthorsebatterystaple',
      secret: 'correcthorsebatterystaple',
    },
    { label: 'a low-entropy assignment', text: 'password=abcdefgh', secret: 'abcdefgh' },
  ];

  for (const { label, text, secret } of cases) {
    it(`redacts ${label}`, () => {
      const result = redact(text);
      expect(result.matches.some((m) => m.rule === 'generic-secret-assignment')).toBe(true);
      expect(result.text).not.toContain(secret);
    });
  }
});

describe('redact: false positives that must survive unredacted', () => {
  const survivors: Record<string, string> = {
    'git SHA': 'commit d2468bb14fd54d4d74a5f06c89961257ab5399d fixed the deadlock',
    UUID: 'session id 550e8400-e29b-41d4-a716-446655440000 was created',
    'normal prose': 'the quick brown fox jumps over the lazy dog near the river',
    'file path': 'see packages/core/src/redaction/redact.ts for the implementation',
    'short base64': 'the flag value was dGVzdA== after decoding',
    'a code reference in key position': 'api_key: process.env.API_KEY',
    'a zod schema declaration': 'password: z.string().min(8)',
    'an absent value': 'client_secret: undefined',
    // The literal shell syntax is the point of this case, not a forgotten template literal.
    // eslint-disable-next-line no-template-curly-in-string -- see comment above
    'a shell interpolation': 'client_secret=${CLIENT_SECRET}',
  };

  for (const [label, text] of Object.entries(survivors)) {
    it(`leaves ${label} untouched`, () => {
      const result = redact(text);
      expect(result.text).toBe(text);
      expect(result.matches).toEqual([]);
    });
  }
});

describe('redact: fingerprint stability', () => {
  it('produces the same fingerprint for the same secret across separate calls', () => {
    const text = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const first = redact(text);
    const second = redact(text);
    expect(first.matches[0]?.fingerprint).toBe(second.matches[0]?.fingerprint);
  });

  it('produces the same fingerprint for the same secret in different surrounding text', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const a = redact(`key one: ${secret}`);
    const b = redact(`a totally different sentence contains ${secret} here`);
    expect(a.matches[0]?.fingerprint).toBe(b.matches[0]?.fingerprint);
  });

  it('produces different fingerprints for different secrets of the same rule', () => {
    const a = redact('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    const b = redact('export AWS_ACCESS_KEY_ID=AKIAZZZZZZZZZZZZZZZZ');
    expect(a.matches[0]?.fingerprint).not.toBe(b.matches[0]?.fingerprint);
  });
});

describe('redact: entropy threshold behavior', () => {
  // 20 chars over 5 distinct symbols: log2(5) = 2.32 bits/char, so the backstop claims it
  // below that threshold and leaves it alone above.
  const text = 'the token is abcdeabcdeabcdeabcde here';

  it('leaves a repetitive token unredacted at the default threshold', () => {
    expect(redact(text).matches).toEqual([]);
  });

  it('redacts the same token when the threshold is lowered below its entropy', () => {
    const result = redact(text, 2.0);
    expect(result.matches.some((m) => m.rule === 'high-entropy')).toBe(true);
    expect(result.text).not.toContain('abcdeabcdeabcdeabcde');
  });
});

describe('redact: secrets carried by their own alphabet and casing', () => {
  it('redacts a 40-char AWS secret key pasted in prose, slashes and all', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = redact(`the runbook still has ${secret} pasted beside it`);

    expect(result.text).not.toContain(secret);
    expect(result.matches.map((match) => match.rule)).toEqual(['high-entropy']);
  });

  it('reaches the same verdict for an env assignment in either casing', () => {
    const value = 'AKIAABCDEFGHIJ23456';
    const upper = redact(`AWS_ACCESS_KEY_ID=${value}`);
    const lower = redact(`aws_access_key_id=${value}`);

    expect(upper.text).not.toContain(value);
    expect(lower.text).not.toContain(value);
    expect(upper.matches).toEqual(lower.matches);
  });
});

describe('redactKeyedValue: the same rules over a structured pair', () => {
  it('fingerprints a value its key names, and returns the value alone', () => {
    const result = redactKeyedValue('password', 'hunter2secret');

    expect(result.text).toBe(result.matches[0]?.fingerprint);
    expect(result.matches.map((match) => match.rule)).toEqual(['generic-secret-assignment']);
  });

  it('gives a secret the same fingerprint whether it arrived embedded or structured', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const embedded = redact(`aws_secret_access_key = ${secret}`);
    const structured = redactKeyedValue('aws_secret_access_key', secret);

    expect(structured.matches).toEqual(embedded.matches);
  });

  it('gives the entropy backstop the same fingerprint whether the pair is embedded or structured', () => {
    // A key outside the credential vocabulary and a value whose own entropy sits just under
    // the threshold: only the whole `key=value` token clears it, so the name's characters are
    // part of what the detector actually matched.
    const key = 'traceId';
    const value = '/DDE6Sz-+HvSRkldFB+WFz+ei';
    const embedded = redact(`${key}=${value}`);
    const structured = redactKeyedValue(key, value);

    expect(embedded.matches.map((match) => match.rule)).toEqual(['high-entropy']);
    expect(structured.matches).toEqual(embedded.matches);
    expect(structured.text).not.toContain(key);
  });

  it('never claims the key it was given as context', () => {
    const result = redactKeyedValue('AWS_ACCESS_KEY_ID', 'AKIAABCDEFGHIJ23456');

    expect(result.text).toBe(result.matches[0]?.fingerprint);
    expect(result.text).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('leaves a placeholder value alone', () => {
    expect(redactKeyedValue('api_key', 'process.env.API_KEY')).toEqual({
      text: 'process.env.API_KEY',
      matches: [],
    });
  });
});

describe('redact: mixed payload with several rule classes at once', () => {
  it('redacts every credential and preserves ordering left to right', () => {
    const text = [
      'AWS key AKIAIOSFODNN7EXAMPLE was pasted next to',
      'a slack token xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
      'in the same tool output.',
    ].join(' ');

    const result = redact(text);
    const rules = result.matches.map((m) => m.rule);
    expect(rules).toEqual(['aws-access-key', 'slack-token']);
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.text).not.toContain('xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx');
  });
});
