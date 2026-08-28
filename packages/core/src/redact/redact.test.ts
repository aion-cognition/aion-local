import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact — true positives, one per rule', () => {
  const cases: Array<{ rule: string; secret: string; text: string }> = [
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

  it('redacts a generic key=value secret only when the value is high-entropy', () => {
    const text = 'password=Zt7pQ4mX9wL2vR8kY5nB3hC6jF1sD0g';
    const result = redact(text);
    const match = result.matches.find((m) => m.rule === 'generic-secret-assignment');
    expect(match).toBeDefined();
    expect(result.text).not.toContain('Zt7pQ4mX9wL2vR8kY5nB3hC6jF1sD0g');
  });
});

describe('redact — false positives that must survive unredacted', () => {
  const survivors: Record<string, string> = {
    'git SHA': 'commit d2468bb14fd54d4d74a5f06c89961257ab5399d fixed the deadlock',
    UUID: 'session id 550e8400-e29b-41d4-a716-446655440000 was created',
    'normal prose': 'the quick brown fox jumps over the lazy dog near the river',
    'file path': 'see packages/core/src/redact/redact.ts for the implementation',
    'short base64': 'the flag value was dGVzdA== after decoding',
    'low-entropy key=value': 'password=abcdefgh',
  };

  for (const [label, text] of Object.entries(survivors)) {
    it(`leaves ${label} untouched`, () => {
      const result = redact(text);
      expect(result.text).toBe(text);
      expect(result.matches).toEqual([]);
    });
  }
});

describe('redact — fingerprint stability', () => {
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

describe('redact — entropy threshold behavior', () => {
  const text = 'password=abcdefgh';

  it('leaves a low-entropy assignment unredacted at the default threshold', () => {
    expect(redact(text).matches).toEqual([]);
  });

  it('redacts the same assignment when the threshold is lowered below its entropy', () => {
    const result = redact(text, 2.0);
    expect(result.matches.some((m) => m.rule === 'generic-secret-assignment')).toBe(true);
    expect(result.text).not.toContain('abcdefgh');
  });
});

describe('redact — mixed payload with several rule classes at once', () => {
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
