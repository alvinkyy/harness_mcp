// Housekeeping at start: delete audit logs, run logs, stored outputs and checkpoints older than
// `retention.days`, and keep at most `retention.maxCheckpoints` checkpoints.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { homePath } from './config.ts'

export function cleanup(config: Config, now = Date.now()): { removed: number } {
  const cutoff = now - config.retention.days * 86_400_000
  let removed = 0
  const old = (path: string) => statSync(path).mtimeMs < cutoff

  for (const [dir, keep] of [
    ['audit', (n: string) => n.endsWith('.jsonl')],
    ['outputs', (n: string) => n.endsWith('.txt')],
    ['runs', (n: string) => n.endsWith('.log')], // index.json is trimmed by the runner itself
  ] as const) {
    const root = homePath(dir)
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      if (keep(name) && old(p)) {
        rmSync(p, { force: true })
        removed++
      }
    }
  }

  const cps = homePath('checkpoints')
  if (existsSync(cps)) {
    // Names start with a sortable timestamp, so newest-first is a reverse sort.
    const all = readdirSync(cps).filter((d) => d.startsWith('cp_')).sort().reverse()
    all.forEach((d, i) => {
      const p = join(cps, d)
      if (i >= config.retention.maxCheckpoints || old(p)) {
        rmSync(p, { recursive: true, force: true })
        removed++
      }
    })
  }
  return { removed }
}
