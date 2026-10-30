// Shared file-editing logic for the apply_patch tool and the control page's paste-to-apply.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCheckpoint } from './checkpoints.ts'
import { applyHunks, parsePatch, PatchError } from './patch.ts'
import { noteBaseline } from './review.ts'
import { noteAgentWrite } from './runner.ts'
import type { Scope } from './scope.ts'
import { sha256 } from './store.ts'

/** Hashes of file contents each client has read, for the read-before-write check. */
const readHashes = new Map<string, Map<string, string>>()

export function rememberRead(clientId: string, path: string, content: Buffer): void {
  let m = readHashes.get(clientId)
  if (!m) readHashes.set(clientId, (m = new Map()))
  m.set(path.toLowerCase(), sha256(content.toString('binary')))
}

export function assertFreshRead(clientId: string, path: string): void {
  const known = readHashes.get(clientId)?.get(path.toLowerCase())
  if (!known) throw new PatchError(`${path} has not been read in this session. Call read_files on it first, then regenerate the change.`)
  const now = sha256(readFileSync(path).toString('binary'))
  if (now !== known) throw new PatchError(`${path} changed since you last read it. Call read_files again and regenerate the change.`)
}

export type ApplyResult = { applied: string[]; checkpoint: string }

/**
 * Validate and apply a patch atomically-ish: everything is checked and computed before the first
 * write, and a checkpoint of every affected file is taken first.
 */
export function applyPatchText(patch: string, workspace: string, scope: Scope, clientId: string, requireRead: boolean): ApplyResult {
  if (patch.includes('[REDACTED:')) {
    throw new PatchError('The patch contains a [REDACTED:...] placeholder. Masked values must not be written back; leave those lines unchanged.')
  }
  const ops = parsePatch(patch)
  type Planned = { path: string; write?: string; remove?: boolean }
  const planned: Planned[] = []
  for (const op of ops) {
    const p = scope.check(op.path, 'write', workspace)
    if (op.kind === 'add') {
      if (existsSync(p)) throw new PatchError(`Add File ${op.path}: file already exists; use Update File.`)
      planned.push({ path: p, write: op.content })
    } else if (op.kind === 'delete') {
      if (!existsSync(p)) throw new PatchError(`Delete File ${op.path}: file does not exist.`)
      if (requireRead) assertFreshRead(clientId, p)
      planned.push({ path: p, remove: true })
    } else {
      if (!existsSync(p)) throw new PatchError(`Update File ${op.path}: file does not exist; use Add File.`)
      if (requireRead) assertFreshRead(clientId, p)
      const current = readFileSync(p, 'utf8')
      const updated = op.hunks.length ? applyHunks(current, op.hunks, op.path) : current
      if (op.moveTo) {
        const dest = scope.check(op.moveTo, 'write', workspace)
        if (existsSync(dest)) throw new PatchError(`Move to ${op.moveTo}: destination exists.`)
        planned.push({ path: dest, write: updated }, { path: p, remove: true })
      } else planned.push({ path: p, write: updated })
    }
  }
  const cp = createCheckpoint(planned.map((x) => x.path), clientId, `apply_patch (${ops.length} file op${ops.length === 1 ? '' : 's'})`)
  noteAgentWrite(planned.flatMap((x) => [x.path, `${x.path}.harness-tmp`]))
  // A patch you paste on the control page is your own change, so only agent edits count as unseen.
  if (clientId !== 'local') noteBaseline(planned.map((x) => x.path))
  for (const x of planned) {
    if (x.remove) rmSync(x.path)
    else if (x.write !== undefined) {
      mkdirSync(dirname(x.path), { recursive: true })
      const tmp = `${x.path}.harness-tmp`
      writeFileSync(tmp, x.write)
      renameSync(tmp, x.path)
      rememberRead(clientId, x.path, readFileSync(x.path))
    }
  }
  return { applied: planned.map((x) => `${x.remove ? 'deleted' : 'wrote'} ${x.path}`), checkpoint: cp.id }
}
