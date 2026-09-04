export type SecretRedaction = {
  content: string;
  redactedCount: number;
};

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
  /((?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key)\s*[:=]\s*["']?)[^\s,"']+/gi,
  /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactSecrets(input: string): SecretRedaction {
  let content = input;
  let redactedCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    content = content.replace(pattern, (...args: unknown[]) => {
      redactedCount += 1;
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return `${prefix}${REDACTED}`;
    });
  }
  return { content, redactedCount };
}
