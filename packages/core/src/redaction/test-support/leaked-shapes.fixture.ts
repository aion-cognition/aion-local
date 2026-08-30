import type { ReflectionInput } from '@aion/protocol';

/**
 * The shapes that reached Neo4j in plaintext, verbatim, plus the material that has to
 * survive beside them. One corpus, so the unit tests, the intake integration test, and the
 * gate harness's redaction battery all assert against the same strings rather than three
 * drifting copies.
 *
 * Every secret here is a published example value (AWS documentation) or synthetic.
 */

/** Standard base64, so it carries `/`: excluding that character splits it below the entropy floor. */
export const AWS_SECRET_WITH_SLASH = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

/** The A/B control: the same key with `/` replaced, so a divergence isolates the slash as the cause. */
export const AWS_SECRET_SLASH_FREE = 'wJalrXUtnFEMIxK7MDENGxbPxRfiCYEXAMPLEKEY';

/** The env-dump value whose verdict swung on the casing of the name beside it. */
export const ENV_DUMP_VALUE = 'AKIAABCDEFGHIJ23456';

/** A credential with no shape of its own: only its key names it. */
export const OPAQUE_PASSWORD = 'Zt7pQ4mX9wL2vR8kY5nB3hC6jF1sD0g';

/** Short, opaque, and under a key the embedded rule's adjacency requirement does not reach. */
export const SUFFIXED_KEY_PASSWORD = 'Zt7pQ4mX9wL2';

export const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

/** An internal service key: no prefix, no vendor shape, too short for the entropy backstop. */
export const SERVICE_TOKEN = 'b7f31ba29c4e6d18';

export type LeakedShape = {
  readonly label: string;
  /** The raw material that must not survive anywhere. */
  readonly material: string;
  /** The rule that claims it. */
  readonly rule: string;
  /** A standalone reflection payload carrying the shape in the position it arrived in. */
  readonly payload: ReflectionInput;
};

export const LEAKED_SHAPES: readonly LeakedShape[] = [
  {
    label: 'a 40-char AWS secret key with slashes, in prose',
    material: AWS_SECRET_WITH_SLASH,
    rule: 'high-entropy',
    payload: {
      turns: [
        { role: 'user', text: `the runbook still has ${AWS_SECRET_WITH_SLASH} pasted beside it` },
      ],
      summary: 'runbook credential review',
    },
  },
  {
    label: 'the slash-free control for the same key',
    material: AWS_SECRET_SLASH_FREE,
    rule: 'high-entropy',
    payload: {
      turns: [{ role: 'user', text: `the older runbook had ${AWS_SECRET_SLASH_FREE} instead` }],
      summary: 'older runbook credential review',
    },
  },
  {
    label: 'an AWS secret key as a nested JSON key/value pair',
    material: AWS_SECRET_WITH_SLASH,
    rule: 'aws-secret-key',
    payload: {
      tool_executions: [
        {
          tool: 'exec_shell',
          status: 'ok',
          input: {
            command: 'env',
            context: { nested: { aws_secret_access_key: AWS_SECRET_WITH_SLASH } },
          },
        },
      ],
      summary: 'shell env dump captured as structured input',
    },
  },
  {
    label: 'an uppercase env assignment inside tool output',
    material: ENV_DUMP_VALUE,
    rule: 'high-entropy',
    payload: {
      tool_executions: [
        {
          tool: 'bash',
          status: 'ok',
          input: 'env | grep AWS',
          output: { stdout: `AWS_ACCESS_KEY_ID=${ENV_DUMP_VALUE}\nGITHUB_TOKEN=${GITHUB_TOKEN}\n` },
        },
      ],
      summary: 'env grep output',
    },
  },
  {
    label: 'the same env assignment in lowercase, in prose',
    material: ENV_DUMP_VALUE,
    rule: 'high-entropy',
    payload: {
      observations: [`the agent pasted aws_access_key_id=${ENV_DUMP_VALUE} into the ticket`],
      summary: 'ticket paste review',
    },
  },
  {
    label: 'an opaque password as a JSON key/value pair',
    material: OPAQUE_PASSWORD,
    rule: 'generic-secret-assignment',
    payload: {
      tool_executions: [
        {
          tool: 'read_file',
          status: 'ok',
          output: { credentials: { host: 'db.internal', password: OPAQUE_PASSWORD } },
        },
      ],
      summary: 'credentials file read',
    },
  },
  {
    label: 'a suffixed credential key whose value has no shape of its own',
    material: SUFFIXED_KEY_PASSWORD,
    rule: 'generic-secret-assignment',
    payload: {
      tool_executions: [
        { tool: 'read_file', status: 'ok', output: { db_password_prod: SUFFIXED_KEY_PASSWORD } },
      ],
      summary: 'production credentials file read',
    },
  },
  {
    label: 'a list of tokens under a credential key',
    material: SERVICE_TOKEN,
    rule: 'generic-secret-assignment',
    payload: {
      tool_executions: [
        { tool: 'list_secrets', status: 'ok', output: { tokens: [GITHUB_TOKEN, SERVICE_TOKEN] } },
      ],
      summary: 'secret manager listing',
    },
  },
];

/**
 * Text that must pass through untouched. The near-threshold entries are deliberate: the
 * token class scans a path or an env assignment as one long run, and `NODE_OPTIONS`
 * (4.47 bits/char) and `GITHUB_REPOSITORY` (4.45) are the closest real shapes to the 4.5
 * floor. A change that redacts them has moved the floor, not fixed a leak.
 */
export const SURVIVING_TEXT: Readonly<Record<string, string>> = {
  'a short git SHA': 'commit d2468bb14fd54d4d74a5f06c89961257ab5399d fixed the deadlock',
  'a full git SHA': 'commit 6f1c2ad9e4b73f08d5ac1e920b7d43f6c8ae5b21 reverted the change',
  'a UUID': 'session id 550e8400-e29b-41d4-a716-446655440000 was created',
  'a short base64 value': 'the flag value was dGVzdA== after decoding',
  'a repo-relative path':
    'see packages/core/src/infrastructure/graph/test-support/neo4j-harness.fixture.ts',
  'an absolute path':
    'at /Users/rhuber/Documents/not-solace-code/aion_code/aion-local/packages/core/src/redaction/redact.ts',
  'a URL with a deep path':
    'https://github.com/solace/aion-local/blob/main/packages/core/src/redaction/redact.ts',
  'a REST path carrying a UUID':
    'GET /api/v2/patients/550e8400-e29b-41d4-a716-446655440000/encounters?limit=50',
  'a sha256 digest':
    'image digest sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'a container reference': 'docker pull ghcr.io/solace-health/aion-local:v0.3.1-rc2',
  'a non-credential env assignment': 'NODE_OPTIONS=--max_old_space_size=8000',
  'a repository env assignment': 'GITHUB_REPOSITORY=solace-health/solace-health-server',
  'a code reference in key position': 'api_key: process.env.API_KEY',
  // The literal shell syntax is the point of this case, not a forgotten template literal.
  // eslint-disable-next-line no-template-curly-in-string -- see comment above
  'a shell interpolation': 'client_secret=${CLIENT_SECRET}',
  'an absent value': 'client_secret: undefined',
};

/**
 * Values that must survive even under a credential key. A pair rule that fingerprints these
 * is redacting the shape of the code rather than a secret.
 */
export const SURVIVING_FIELDS: readonly { readonly key: string; readonly value: string }[] = [
  { key: 'api_key', value: 'process.env.API_KEY' },
  // The literal shell syntax is the point of this case, not a forgotten template literal.
  // eslint-disable-next-line no-template-curly-in-string -- see comment above
  { key: 'client_secret', value: '${CLIENT_SECRET}' },
  { key: 'token', value: 'undefined' },
  { key: 'password', value: 'z.string().min(8)' },
  { key: 'access_key', value: 'rotate it before the next deploy' },
  { key: 'token_type', value: 'bearer' },
  { key: 'tokenizer', value: 'bert-base-uncased' },
  { key: 'secretariat', value: 'reviewed-2026-08' },
];
