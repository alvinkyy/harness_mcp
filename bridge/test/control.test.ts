// The control page must load as working JavaScript: a single syntax error silently disables every
// button and the live refresh.

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import * as h from './helpers.ts'

after(() => h.running.close())

test('control page script parses and wires buttons through data attributes', async () => {
  const html = await (await fetch(`${h.CONTROL}/`)).text()
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
  assert.ok(script, 'page has a script')
  assert.doesNotThrow(() => new Function(script), 'page script must parse')
  assert.doesNotMatch(html, /\sonclick=/, 'no inline onclick handlers (fragile quoting)')
  assert.match(html, /data-act="mode"/)
})

test('control state includes what the countdowns need', async () => {
  const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as Record<string, unknown>
  for (const k of ['serverTime', 'toolWaitSec', 'mode', 'connects', 'actions', 'runs', 'checkpoints', 'audit']) assert.ok(k in s, k)
})

test('decisions are logged with their own kind', async () => {
  const t = await h.connect('full')
  void h.callTool(t.access_token, 'run', { command: 'echo audit-kind-check' })
  let id = ''
  for (let i = 0; i < 50 && !id; i++) {
    const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { actions: { id: string; summary: string }[] }
    id = s.actions.find((a) => a.summary.includes('audit-kind-check'))?.id ?? ''
    if (!id) await new Promise((r) => setTimeout(r, 100))
  }
  await h.control(`/api/action/${id}/deny`)
  const s = (await (await fetch(`${h.CONTROL}/api/state`)).json()) as { audit: { kind: string; summary?: string }[] }
  assert.ok(s.audit.some((a) => a.kind === 'local-decision' && a.summary?.includes('audit-kind-check')))
})
