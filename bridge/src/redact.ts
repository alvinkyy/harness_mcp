// Outgoing redaction (Exabytes AI policy): every payload that leaves this PC passes through here.
// Secrets are replaced with a labelled placeholder; card numbers keep only their last 4 digits.

export type RedactionResult = { text: string; hits: Record<string, number> }

type Rule = { label: string; re: RegExp; replace: (match: string, ...groups: string[]) => string }

const RULES: Rule[] = [
  {
    label: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED:private-key]',
  },
  { label: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws-access-key]' },
  { label: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replace: () => '[REDACTED:github-token]' },
  { label: 'openai-key', re: /\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g, replace: () => '[REDACTED:api-key]' },
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: () => '[REDACTED:api-key]' },
  { label: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => '[REDACTED:slack-token]' },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => '[REDACTED:google-api-key]' },
  { label: 'stripe-key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g, replace: () => '[REDACTED:stripe-key]' },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => '[REDACTED:jwt]' },
  {
    label: 'bearer-token',
    re: /\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED:token]`,
  },
  {
    label: 'connection-string-password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi,
    replace: (_m, a, _pw, c) => `${a}[REDACTED:password]${c}`,
  },
  {
    // Quoted literal assigned to a secret-sounding name: $password = 'x', "apiKey": "x", SECRET => 'x'.
    // Only string literals are masked, so ordinary code (token = req.body.token) stays intact.
    label: 'secret-assignment',
    re: /((?:["']?[A-Za-z0-9_.$-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|token|private[_-]?key|client[_-]?secret|cc_encryption_hash|encryption[_-]?key|license[_-]?key)[A-Za-z0-9_.-]*["']?)\s*(?:=>|:=|=|:)\s*)(["'])([^"'\r\n]{6,})\2/gi,
    replace: (match, prefix, quote, value) =>
      isPlaceholder(value) ? match : `${prefix}${quote}[REDACTED:secret]${quote}`,
  },
  {
    // Unquoted env/ini style: DB_PASSWORD=hunter22, export API_TOKEN=abc...
    label: 'secret-env-line',
    re: /^(\s*(?:export\s+)?[A-Za-z0-9_.]*(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|TOKEN|PRIVATE_KEY|ACCESS_KEY|ENCRYPTION_KEY)[A-Za-z0-9_.]*\s*=\s*)([^\s#'"]{6,})/gim,
    replace: (match, prefix, value) => (isPlaceholder(value) ? match : `${prefix}[REDACTED:secret]`),
  },
]

function isPlaceholder(value: string): boolean {
  return /^\$\{|^\$[A-Z_]|process\.env|getenv|env\(|^<.*>$|^(your|my)[-_]|^x{4,}$|changeme|placeholder|example|^\*+$|REDACTED/i.test(
    value,
  )
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g

export function redact(input: string): RedactionResult {
  const hits: Record<string, number> = {}
  let text = input
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: string[]) => {
      hits[rule.label] = (hits[rule.label] ?? 0) + 1
      return rule.replace(args[0], ...args.slice(1))
    })
  }
  text = text.replace(CARD_RE, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match
    if (/^(\d)\1+$/.test(digits)) return match
    hits['card-number'] = (hits['card-number'] ?? 0) + 1
    return `[REDACTED:card ending ${digits.slice(-4)}]`
  })
  return { text, hits }
}
