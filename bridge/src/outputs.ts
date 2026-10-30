// Spill store: long outputs are kept on disk and the agent gets head + tail + a handle it can page
// through with read_output (dsh's spill-policy idea).

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from './config.ts'

export function storeOutput(text: string): string {
  const dir = homePath('outputs')
  mkdirSync(dir, { recursive: true })
  const handle = `out_${randomUUID()}`
  writeFileSync(`${dir}/${handle}.txt`, text)
  return handle
}

export function readOutput(handle: string, offset: number, limit: number): { text: string; total: number } | null {
  if (!/^(out|run)_[0-9a-f-]{36}$/.test(handle)) return null
  const file = handle.startsWith('run_') ? homePath('runs', `${handle}.log`) : homePath('outputs', `${handle}.txt`)
  if (!existsSync(file)) return null
  const all = readFileSync(file, 'utf8')
  return { text: all.slice(offset, offset + limit), total: all.length }
}

/** Fit text into `limit` characters; anything longer is stored and summarized. */
export function fit(text: string, limit: number): string {
  if (text.length <= limit) return text
  const handle = storeOutput(text)
  const head = text.slice(0, Math.floor(limit * 0.6))
  const tail = text.slice(-Math.floor(limit * 0.3))
  return `${head}\n\n… [${text.length - head.length - tail.length} characters omitted — call read_output with handle "${handle}" to page through the full text] …\n\n${tail}`
}
