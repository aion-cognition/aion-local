export type RedactionRule = {
  id: string;
  pattern: RegExp;
  /**
   * When true, a match's captured `secret` group is only accepted if its Shannon
   * entropy clears the configured threshold. Needed for shapes like `password=` that
   * are otherwise indistinguishable from a trivial, non-secret assignment.
   */
  gateByEntropy?: boolean;
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

const GENERIC_SECRET_ASSIGNMENT =
  /\b(?:password|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?(?<secret>[A-Za-z0-9+/_.=-]{8,})["']?/i;

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
  { id: 'generic-secret-assignment', pattern: GENERIC_SECRET_ASSIGNMENT, gateByEntropy: true },
];

export const REDACTION_RULE_IDS: readonly string[] = Array.from(
  new Set(REDACTION_RULES.map((rule) => rule.id)),
);

/** The high-entropy backstop (`entropy.ts`) tags its own matches with this id. */
export const HIGH_ENTROPY_RULE_ID = 'high-entropy';
