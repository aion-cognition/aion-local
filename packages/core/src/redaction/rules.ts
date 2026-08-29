export type RedactionRule = {
  id: string;
  pattern: RegExp;
};

const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/;

/** AWS secret keys are unstructured base64; only the paired env-var name makes them recognizable. */
const AWS_SECRET_KEY =
  /\b(?:aws_secret_access_key|aws_secret_key)\b\s*[:=]\s*["']?(?<secret>[A-Za-z0-9/+]{40})["']?/i;

const GITHUB_TOKEN_CLASSIC = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/;
const GITHUB_TOKEN_FINE_GRAINED = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{20,}\b/;

/** `eyJ` anchors on the base64 of a JSON header (`{"`), which every JWT starts with. */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;

const PEM_PRIVATE_KEY =
  /-----BEGIN ((?:RSA|EC|OPENSSH|DSA|ENCRYPTED)? ?PRIVATE KEY)-----[\s\S]+?-----END \1-----/;

/** Only the `user:pass` segment is captured, so the scheme/host/db stay visible for co-occurrence structure. */
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|amqps?):\/\/(?<secret>[^\s:@/]+:[^\s:@/]+)@/i;

const SLACK_TOKEN = /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/;

/** Checked before the OpenAI rule so an Anthropic key's `sk-ant-` range is claimed first. */
const ANTHROPIC_API_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/;
const OPENAI_API_KEY = /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/;

/**
 * The credential-key vocabulary and the value shape that follows one, split out because
 * three surfaces have to agree on them: the embedded `key=value` rule below, and the two
 * predicates the deep walk uses to apply that same judgement to a structured JSON field,
 * where the key and the value are separate strings and no single string ever holds both.
 * One definition, so the structured path can never drift from the embedded one.
 *
 * The value is any run of 8+ non-delimiter characters, which is wide enough for shell
 * and env passwords (`P@ssw0rd!`) that an alphanumeric class drops on their first
 * symbol. `.` is excluded from that run because it is what separates a real secret from
 * a code reference: `api_key: process.env.API_KEY` truncates to `process`, under the
 * length floor, and survives intact.
 */
const CREDENTIAL_KEY_WORDS = String.raw`password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret`;
const CREDENTIAL_VALUE_BODY = String.raw`(?!(?:undefined|redacted)\b)[^\s"'\x60.,;:<>(){}[\]\\]{8,}`;

/**
 * The catch-all for credentials with no recognizable shape of their own, which is most
 * of them: DB passwords, internal service keys, vendor keys with no prefix.
 *
 * No word boundary before the key name, so `DB_PASSWORD=` and `OPENAI_API_KEY=` match —
 * `_` is a word character, so `\b` never fires between it and the name.
 *
 * No entropy gate. Shannon entropy over a short string is bounded by log2(length), so a
 * 4.5 bits/char threshold is unreachable below 23 characters — the exact band where
 * real passwords and API keys live — and it does not separate `hunter2secret` (3.0)
 * from `process.env.API_KEY` (3.9) anyway. Length plus the delimiter class does that
 * work, and over-redacting a placeholder costs a fingerprint, not a leak.
 */
const GENERIC_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?:${CREDENTIAL_KEY_WORDS})\s*[:=]\s*["']?(?<secret>${CREDENTIAL_VALUE_BODY})`,
  'i',
);

/**
 * A structured field name is the whole context a JSON value gets, so the match is on
 * containment rather than adjacency: `AWS_ACCESS_KEY_ID` and `db_password_prod` are
 * credential keys, though neither puts the vocabulary word against the delimiter the way
 * the embedded rule requires.
 *
 * Containment is bounded by name segments — `_`, `-`, a case hump, or either end — with an
 * optional plural. Whole words that merely start with a vocabulary word are not credential
 * keys, and the distinction is not cosmetic: `tokenizer` and `secretariat` name ordinary
 * telemetry, and fingerprinting their values would destroy content permanently, since
 * nothing in the substrate is ever hard-deleted.
 */
const CREDENTIAL_KEY_NAME = new RegExp(String.raw`(?:^|_)(?:${CREDENTIAL_KEY_WORDS})s?(?:$|_)`);

/** `apiKeyValue`, `x-api-key`, and `API_KEY` are one name; segment boundaries are all `_`. */
function segmentKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

/** The embedded rule's value class, anchored: what a whole JSON value has to look like. */
const CREDENTIAL_VALUE = new RegExp(String.raw`^${CREDENTIAL_VALUE_BODY}$`, 'i');

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_NAME.test(segmentKey(key));
}

export function isCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE.test(value);
}

/**
 * Priority order, not declaration order for its own sake: earlier rules claim their
 * match range first, so a later, broader rule (chiefly `generic-secret-assignment`)
 * never re-matches material a specific rule already fingerprinted. Block-shaped and
 * anchored patterns (PEM, JWT, provider prefixes) come first for the same reason.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  { id: 'pem-private-key', pattern: PEM_PRIVATE_KEY },
  { id: 'jwt', pattern: JWT },
  { id: 'aws-access-key', pattern: AWS_ACCESS_KEY },
  { id: 'aws-secret-key', pattern: AWS_SECRET_KEY },
  { id: 'github-token', pattern: GITHUB_TOKEN_CLASSIC },
  { id: 'github-token', pattern: GITHUB_TOKEN_FINE_GRAINED },
  { id: 'gitlab-token', pattern: GITLAB_TOKEN },
  { id: 'anthropic-api-key', pattern: ANTHROPIC_API_KEY },
  { id: 'openai-api-key', pattern: OPENAI_API_KEY },
  { id: 'slack-token', pattern: SLACK_TOKEN },
  { id: 'connection-string', pattern: CONNECTION_STRING },
  { id: 'generic-secret-assignment', pattern: GENERIC_SECRET_ASSIGNMENT },
];

export const REDACTION_RULE_IDS: readonly string[] = Array.from(
  new Set(REDACTION_RULES.map((rule) => rule.id)),
);

/** The high-entropy backstop (`entropy.ts`) tags its own matches with this id. */
export const HIGH_ENTROPY_RULE_ID = 'high-entropy';
