// Automatic access requests, run history on disk, watch-mode skip and retention cleanup.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as h from './helpers.ts'
import { homePath } from '../src/config.ts'
import { cleanup } from '../src/retention.ts'
import { noteAgentWrite, writtenByAgent } from '../src/runner.ts'

after(() => h.running.close())

type Pending = { id: string; kind: string; summary: string; detail: Record<string, unknown> }

async function waitForPending(match: (a: Pending) => boolean): Promise<Pending> {
  for (let i = 0; i < 60; i++) {
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: Pending[] }
    const a = s.actions.find(match)
    if (a) return a
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('pending action never appeared')
}

describe('Automatic access requests', () => {
  let t: h.Tokens
  before(async () => {
    t = await h.connect('full')
  })

  test('reading outside the allowed folders asks the user, and continues in the same call once allowed', async () => {
    const other = join(h.root, 'another-project')
    mkdirSync(other, { recursive: true })
    h.write(join(other, 'notes.md'), 'shared helper notes')
    const call = h.callTool(t.access_token, 'read_files', { files: [{ path: join(other, 'notes.md') }] })
    const req = await waitForPending((a) => a.kind === 'access' && String(a.detail.path).endsWith('another-project'))
    assert.equal(req.detail.mode, 'read')
    assert.equal(req.detail.automatic, true)
    assert.match(String(req.detail.reason), /read files/)
    await h.control(`/api/action/${req.id}/approve`, { mode: 'read' })
    const r = await call
    assert.match(r.text, /shared helper notes/)
  })

  test('writing outside the workspace asks for write access; refusing ends the call clearly', async () => {
    const other = join(h.root, 'write-target')
    mkdirSync(other, { recursive: true })
    const call = h.callTool(t.access_token, 'write_file', { path: join(other, 'new.txt'), content: 'x' })
    const req = await waitForPending((a) => a.kind === 'access' && String(a.detail.path).endsWith('write-target'))
    assert.equal(req.detail.mode, 'write')
    await h.control(`/api/action/${req.id}/deny`)
    const r = await call
    assert.match(r.text, /refused write access/)
    assert.equal(existsSync(join(other, 'new.txt')), false)
    // A second attempt in the same session is refused at once, without asking again.
    const again = await h.callTool(t.access_token, 'write_file', { path: join(other, 'new.txt'), content: 'x' })
    assert.match(again.text, /refused write access/)
  })

  test('never-shared paths are refused without asking', async () => {
    const before = ((await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: unknown[] }).actions.length
    const r = await h.callTool(t.access_token, 'read_files', { files: [{ path: 'C:\\Windows\\win.ini' }] })
    assert.match(r.text, /Access denied/)
    const afterCount = ((await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: unknown[] }).actions.length
    assert.equal(afterCount, before)
  })
})

test('run history is saved to disk', async () => {
  const t = await h.connect('full')
  h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  const r = await h.callTool(t.access_token, 'run_tests', {})
  const id = /"id": "(run_[^"]+)"/.exec(r.text)![1]
  await new Promise((res) => setTimeout(res, 600))
  const index = JSON.parse(readFileSync(homePath('runs', 'index.json'), 'utf8')) as { id: string; status: string }[]
  assert.equal(index.find((x) => x.id === id)?.status, 'passed')
})

test('watch mode skips files the agent just wrote, but not later edits', () => {
  const p = join(h.workspace, 'calc.py')
  noteAgentWrite([p])
  assert.equal(writtenByAgent(p), true)
  assert.equal(writtenByAgent(p.toUpperCase()), true, 'Windows paths compare case-insensitively')
  assert.equal(writtenByAgent(join(h.workspace, 'other.py')), false)
})

test('cleanup removes old logs and checkpoints and keeps recent ones', () => {
  const old = new Date(Date.now() - 30 * 86_400_000)
  mkdirSync(homePath('audit'), { recursive: true })
  mkdirSync(homePath('checkpoints', 'cp_20200101000000_aaaaaaaa'), { recursive: true })
  const oldLog = homePath('audit', '2020-01-01.jsonl')
  const newLog = homePath('audit', 'keep-me.jsonl')
  writeFileSync(oldLog, '{}\n')
  writeFileSync(newLog, '{}\n')
  utimesSync(oldLog, old, old)
  utimesSync(homePath('checkpoints', 'cp_20200101000000_aaaaaaaa'), old, old)
  const { removed } = cleanup(h.config)
  assert.ok(removed >= 2)
  assert.equal(existsSync(oldLog), false)
  assert.equal(existsSync(homePath('checkpoints', 'cp_20200101000000_aaaaaaaa')), false)
  assert.equal(existsSync(newLog), true)
})
