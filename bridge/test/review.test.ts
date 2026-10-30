// Approval cards show what agents changed since your last approval, and untrusted workspaces hold
// test runs on unseen agent changes until you approve them.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as h from './helpers.ts'
import { lineDiff } from '../src/review.ts'

after(() => h.running.close())

type Change = { path: string; status: string; added: number; removed: number; diff: string }
type Pending = { id: string; kind: string; summary: string; detail: Record<string, unknown>; trusted?: boolean; changes?: Change[] }
type State = { actions: Pending[]; trust: { path: string; trusted: boolean; unseen: number }[] }

async function state(): Promise<State> {
  return (await (await fetch(`${h.CONTROL}/api/state`)).json()) as State
}

async function waitForPending(match: (a: Pending) => boolean): Promise<Pending> {
  for (let i = 0; i < 50; i++) {
    const a = (await state()).actions.find(match)
    if (a) return a
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('pending action never appeared')
}

const fix = (from: string, to: string) => `*** Begin Patch\n*** Update File: calc.js\n-${from}\n+${to}\n*** End Patch`

test('lineDiff shows changed lines with context and counts', () => {
  const a = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')
  const b = ['one', 'two', 'three', 'FOUR', 'five', 'six', 'seven', 'eight', 'nine'].join('\n')
  const d = lineDiff(a, b)
  assert.equal(d.added, 2)
  assert.equal(d.removed, 1)
  assert.match(d.diff, /-four\n\+FOUR/)
  assert.match(d.diff, /\+nine/)
  assert.match(d.diff, / three/, 'keeps context')
  assert.equal(lineDiff('', 'new\nfile').added, 2)
})

describe('Trust and approval cards', () => {
  let t: h.Tokens
  let ws: string
  before(async () => {
    t = await h.connect('full')
    h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }))
    h.write(join(h.workspace, 'calc.js'), 'exports.add = (a, b) => a - b\n')
    h.write(join(h.workspace, 'check.js'), "if (require('./calc.js').add(2, 3) !== 5) process.exit(1)\nconsole.log('ok')\n")
    ws = (await state()).trust[0].path
  })

  test('configured workspaces start trusted: tests run without asking', async () => {
    assert.equal((await state()).trust[0].trusted, true)
    await h.callTool(t.access_token, 'read_files', { files: [{ path: 'calc.js' }] })
    const r = await h.callTool(t.access_token, 'apply_patch', { patch: fix('exports.add = (a, b) => a - b', 'exports.add = (a, b) => a + b'), runTests: true })
    assert.match(r.text, /"status": "passed"/, r.text)
    assert.equal((await state()).trust[0].unseen, 1, 'the change is still unseen: nobody approved anything')
  })

  test('a command card lists the unseen agent changes with a diff; approving marks them seen', async () => {
    const call = h.callTool(t.access_token, 'run', { command: 'echo card-check' })
    const action = await waitForPending((a) => a.summary.includes('card-check'))
    assert.equal(action.trusted, true)
    assert.equal(action.changes?.length, 1)
    assert.match(action.changes![0].path, /calc\.js$/)
    assert.match(action.changes![0].diff, /-exports\.add = \(a, b\) => a - b\n\+exports\.add = \(a, b\) => a \+ b/)
    await h.control(`/api/action/${action.id}/approve`)
    assert.match((await call).text, /"status": "passed"/)
    assert.equal((await state()).trust[0].unseen, 0)
  })

  test('untrusted: tests on unseen agent changes wait for approval, then run in the same call', async () => {
    assert.equal((await h.control('/api/trust', { path: ws, trusted: false })).status, 200)
    const r0 = await h.callTool(t.access_token, 'run_tests')
    assert.match(r0.text, /"status": "passed"/, 'no unseen changes: runs at once')

    const call = h.callTool(t.access_token, 'apply_patch', { patch: fix('exports.add = (a, b) => a + b', 'exports.add = (a, b) => b + a'), runTests: true })
    const action = await waitForPending((a) => a.kind === 'command' && a.detail.tests === true)
    assert.equal(action.trusted, false)
    assert.match(action.changes![0].diff, /\+exports\.add = \(a, b\) => b \+ a/)
    await h.control(`/api/action/${action.id}/approve`)
    assert.match((await call).text, /"status": "passed"/)
  })

  test('untrusted: the recipe command through run waits too, and refusing tells the agent not to retry', async () => {
    await h.callTool(t.access_token, 'read_files', { files: [{ path: 'calc.js' }] })
    await h.callTool(t.access_token, 'apply_patch', { patch: fix('exports.add = (a, b) => b + a', 'exports.add = (a, b) => a + b') })
    const call = h.callTool(t.access_token, 'run', { command: 'npm test' })
    const action = await waitForPending((a) => a.summary === 'npm test')
    await h.control(`/api/action/${action.id}/deny`)
    const r = await call
    assert.match(r.text, /"status": "denied"/)
    assert.match(r.text, /Do not retry/)
  })

  test('Mark as seen clears unseen changes, and pasted patches never count', async () => {
    assert.ok((await state()).trust[0].unseen > 0)
    await h.control('/api/reviewed', { path: ws })
    assert.equal((await state()).trust[0].unseen, 0)
    const patch = fix('exports.add = (a, b) => a + b', 'exports.add = (x, y) => x + y')
    assert.equal((await h.control('/api/apply', { patch })).status, 200)
    assert.equal((await state()).trust[0].unseen, 0)
    const r = await h.callTool(t.access_token, 'run_tests')
    assert.match(r.text, /"status": "passed"/, 'your own change runs without asking')
  })

  test('only writable folders can be trusted', async () => {
    assert.equal((await h.control('/api/trust', { path: h.outside, trusted: true })).status, 400)
  })
})
