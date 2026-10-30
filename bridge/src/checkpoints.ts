// Checkpoints: before any write, the previous content of every affected file is saved so a fix can
// be undone even in folders that are not git repositories.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homePath, writeJsonAtomic } from './config.ts'

export type CheckpointFile = { path: string; existed: boolean; blob?: string }
export type Checkpoint = { id: string; createdAt: string; clientId: string; reason: string; files: CheckpointFile[] }

export function createCheckpoint(paths: string[], clientId: string, reason: string): Checkpoint {
  const id = `cp_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`
  const dir = homePath('checkpoints', id)
  mkdirSync(dir, { recursive: true })
  const files: CheckpointFile[] = [...new Set(paths)].map((path, i) => {
    if (!existsSync(path)) return { path, existed: false }
    const blob = `${i}.bin`
    writeFileSync(`${dir}/${blob}`, readFileSync(path))
    return { path, existed: true, blob }
  })
  const cp: Checkpoint = { id, createdAt: new Date().toISOString(), clientId, reason, files }
  writeJsonAtomic(`${dir}/manifest.json`, cp)
  return cp
}

export function listCheckpoints(limit = 20): Checkpoint[] {
  const root = homePath('checkpoints')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => existsSync(`${root}/${d}/manifest.json`))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((d) => JSON.parse(readFileSync(`${root}/${d}/manifest.json`, 'utf8')) as Checkpoint)
}

export function getCheckpoint(id: string): Checkpoint | null {
  if (!/^cp_\d{14}_[0-9a-f]{8}$/.test(id)) return null
  const file = homePath('checkpoints', id, 'manifest.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Checkpoint) : null
}

/** Restore every file to its state before the checkpoint (files that did not exist are removed). */
export function restoreCheckpoint(cp: Checkpoint): string[] {
  const dir = homePath('checkpoints', cp.id)
  const restored: string[] = []
  for (const f of cp.files) {
    if (f.existed && f.blob) {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, readFileSync(`${dir}/${f.blob}`))
    } else if (existsSync(f.path)) {
      rmSync(f.path)
    }
    restored.push(f.path)
  }
  return restored
}
