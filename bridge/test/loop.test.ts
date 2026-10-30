// The seamless fix loop: approvals answered inside the open tool call, apply_patch + tests in one
// call, and recipe detection for plain Python projects.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as h from './helpers.ts'
import { recipeFor } from '../src/runner.ts'

after(() => h.running.close())

type Pending = { id: string; kind: string; summary: string; detail: Record<string, unknown> }

async function waitForPending(match: (a: Pending) => boolean): Promise<Pending> {
  for (let i = 0; i < 50; i++) {
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: Pending[] }
    const a = s.actions.find(match)
    if (a) return a
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('pending action never appeared')
}

describe('Seamless loop', () => {
  let t: h.Tokens
  before(async () => {
    t = await h.connect('full')
  })

  test('a command approved while the call is open returns its result in the same call', async () => {
    const call = h.callTool(t.access_token, 'run', { command: 'echo approved-in-call' })
    const action = await waitForPending((a) => a.summary.includes('approved-in-call'))
    await h.control(`/api/action/${action.id}/approve`)
    const r = await call
    assert.match(r.text, /"status": "passed"/, r.text)
    assert.match(r.text, /approved-in-call/)
  })

  test('a command denied while the call is open returns denied with guidance', async () => {
    const call = h.callTool(t.access_token, 'run', { command: 'echo will-be-denied' })
    const action = await waitForPending((a) => a.summary.includes('will-be-denied'))
    await h.control(`/api/action/${action.id}/deny`)
    const r = await call
    assert.match(r.text, /"status": "denied"/)
    assert.match(r.text, /Do not retry/)
  })

  test('apply_patch with runTests applies the fix and returns the test result in one call', async () => {
    h.write(join(h.workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }))
    h.write(join(h.workspace, 'calc.js'), 'exports.add = (a, b) => a - b\n')
    h.write(join(h.workspace, 'check.js'), "if (require('./calc.js').add(2, 3) !== 5) { console.error('calc.js:1 add(2,3) should be 5'); process.exit(1) }\nconsole.log('ok')\n")
    await h.callTool(t.access_token, 'read_files', { files: [{ path: 'calc.js' }] })
    const patch = '*** Begin Patch\n*** Update File: calc.js\n-exports.add = (a, b) => a - b\n+exports.add = (a, b) => a + b\n*** End Patch'
    const r = await h.callTool(t.access_token, 'apply_patch', { patch, runTests: true })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /"checkpoint": "cp_/)
    assert.match(r.text, /"status": "passed"/, r.text)
  })

  test('folder access approved while the call is open is usable at once', async () => {
    const extra = join(h.root, 'extra-project')
    mkdirSync(extra, { recursive: true })
    h.write(join(extra, 'readme.txt'), 'hello from extra')
    const call = h.callTool(t.access_token, 'request_access', { path: extra, mode: 'read', reason: 'need to read the shared helper' })
    const action = await waitForPending((a) => a.kind === 'access')
    await h.control(`/api/action/${action.id}/approve`, { mode: 'read' })
    assert.match((await call).text, /"status": "approved"/)
    const read = await h.callTool(t.access_token, 'read_files', { files: [{ path: join(extra, 'readme.txt') }] })
    assert.match(read.text, /hello from extra/)
  })

  test('server instructions describe the fix loop', async () => {
    const { body } = await h.rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.match(body.result.instructions, /fix loop/)
  })
})

test('plain Python projects get the unittest recipe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'py-'))
  writeFileSync(join(dir, 'calculator.py'), '')
  writeFileSync(join(dir, 'test_calculator.py'), '')
  assert.deepEqual(recipeFor(dir, h.config)?.commands, ['python -m unittest -v'])
})
