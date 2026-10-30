// Append-only audit log: every tool call, connection event and local decision, one JSON line each.
// Files rotate daily: ~/.harness-mcp/audit/YYYY-MM-DD.jsonl

import { appendFileSync, mkdirSync } from 'node:fs'
import { homePath } from './config.ts'

const MAX_FIELD = 20_000
const recent: Record<string, unknown>[] = []

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…[${value.length} chars]` : value
  if (Array.isArray(value)) return value.map(clip)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]))
  return value
}

export function audit(kind: string, data: Record<string, unknown>): void {
  // `kind` goes last so a data field with the same name can't overwrite the entry type.
  const entry = { time: new Date().toISOString(), ...(clip(data) as Record<string, unknown>), kind }
  recent.push(entry)
  if (recent.length > 200) recent.shift()
  const dir = homePath('audit')
  mkdirSync(dir, { recursive: true })
  appendFileSync(`${dir}/${entry.time.slice(0, 10)}.jsonl`, JSON.stringify(entry) + '\n')
}

export function recentAudit(limit = 50): Record<string, unknown>[] {
  return recent.slice(-limit).reverse()
}
