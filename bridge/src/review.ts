// What agents changed since you last approved something in a workspace, shown on approval cards,
// and whether a workspace is trusted. In an untrusted workspace the test recipe (which runs code the
// agent wrote) waits for your approval whenever there are changes you haven't seen yet.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homePath, writeJsonAtomic, type Config } from './config.ts'
import { canonical, isInside, type Scope } from './scope.ts'
import type { Store } from './store.ts'

/** Content of a file before the first agent change since the last approval (null: it didn't exist). */
type Baseline = { path: string; before: string | null; large?: boolean }

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number; diff: string }

const MAX_BYTES = 512 * 1024
const MAX_DIFF_LINES = 200

let ledger: Record<string, Baseline> | null = null

function file(): string {
  return homePath('review.json')
}

function load(): Record<string, Baseline> {
  if (ledger) return ledger
  try {
    ledger = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Baseline>) : {}
  } catch {
    ledger = {}
  }
  return ledger
}

function readSmall(path: string): { text: string | null; large: boolean } {
  if (!existsSync(path)) return { text: null, large: false }
  if (statSync(path).size > MAX_BYTES) return { text: null, large: true }
  return { text: readFileSync(path, 'utf8'), large: false }
}

/** Call before an agent writes, moves or deletes files: remembers how they looked before. */
export function noteBaseline(paths: string[]): void {
  const l = load()
  let changed = false
  for (const p of paths) {
    const key = p.toLowerCase()
    if (l[key]) continue
    const { text, large } = readSmall(p)
    l[key] = large ? { path: p, before: null, large: true } : { path: p, before: text }
    changed = true
  }
  if (changed) writeJsonAtomic(file(), l)
}

function under(root: string): Baseline[] {
  return Object.values(load()).filter((b) => isInside(b.path, root))
}

/** Files agents changed under `root` since the last approval there, with a short diff each. */
export function changesUnder(root: string): FileChange[] {
  const out: FileChange[] = []
  for (const b of under(root)) {
    const now = readSmall(b.path)
    if (b.large || now.large) {
      out.push({ path: b.path, status: now.text === null && !now.large ? 'deleted' : 'modified', added: 0, removed: 0, diff: '(file too large to show)' })
      continue
    }
    if (now.text === b.before) continue
    const status = b.before === null ? 'added' : now.text === null ? 'deleted' : 'modified'
    out.push({ path: b.path, status, ...lineDiff(b.before ?? '', now.text ?? '') })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function hasChangesUnder(root: string): boolean {
  return under(root).some((b) => {
    if (b.large) return true
    const now = readSmall(b.path)
    return now.large || now.text !== b.before
  })
}

/** You approved something here: what you were shown counts as seen. */
export function clearUnder(root: string): void {
  const l = load()
  for (const [key, b] of Object.entries(l)) if (isInside(b.path, root)) delete l[key]
  writeJsonAtomic(file(), l)
}

/** The outermost writable folder containing `dir` (the workspace it belongs to), or `dir` itself. */
export function rootFor(dir: string, scope: Scope): string {
  const roots = scope.writeRoots().filter((r) => isInside(dir, r))
  return roots.sort((a, b) => a.length - b.length)[0] ?? canonical(dir)
}

/** Configured workspaces start trusted; folders shared on request start untrusted. The control page can change either. */
export function isTrusted(root: string, config: Config, store: Store): boolean {
  const set = store.state.trust?.[root.toLowerCase()]
  if (set !== undefined) return set
  return config.workspaces.some((w) => canonical(w).toLowerCase() === root.toLowerCase())
}

/** Whether running the test recipe in `dir` needs the user's approval first. */
export function needsReview(dir: string, config: Config, store: Store, scope: Scope): boolean {
  const root = rootFor(dir, scope)
  return !isTrusted(root, config, store) && hasChangesUnder(root)
}

/** A unified-style line diff with 2 lines of context, cut to MAX_DIFF_LINES. */
export function lineDiff(a: string, b: string): { added: number; removed: number; diff: string } {
  const x = a === '' ? [] : a.split(/\r?\n/)
  const y = b === '' ? [] : b.split(/\r?\n/)
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let endX = x.length
  let endY = y.length
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) (endX--, endY--)
  const xs = x.slice(start, endX)
  const ys = y.slice(start, endY)
  if (xs.length * ys.length > 4_000_000) {
    return { added: ys.length, removed: xs.length, diff: `(large change: ${xs.length} lines replaced by ${ys.length})` }
  }
  // Longest common subsequence over the changed middle.
  const n = xs.length
  const m = ys.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops: { t: ' ' | '-' | '+'; s: string }[] = []
  for (let k = Math.max(0, start - 2); k < start; k++) ops.push({ t: ' ', s: x[k] })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) (ops.push({ t: ' ', s: xs[i] }), i++, j++)
    // Removed lines before added ones, as in git.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: '-', s: xs[i++] })
    else ops.push({ t: '+', s: ys[j++] })
  }
  for (let k = endX; k < Math.min(x.length, endX + 2); k++) ops.push({ t: ' ', s: x[k] })
  // Drop unchanged runs longer than 4 lines inside the middle, keeping 2 lines of context each side.
  const lines: string[] = []
  let added = 0
  let removed = 0
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k]
    if (o.t === '+') added++
    if (o.t === '-') removed++
    if (o.t === ' ') {
      const near = ops.slice(Math.max(0, k - 2), k + 3).some((p) => p.t !== ' ')
      if (!near) {
        if (lines.at(-1) !== '…') lines.push('…')
        continue
      }
    }
    lines.push(`${o.t}${o.s}`)
  }
  if (start > 2) lines.unshift(`@@ line ${start - 1}`)
  const shown = lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`] : lines
  return { added, removed, diff: shown.join('\n') }
}
