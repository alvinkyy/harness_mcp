// Limits-only hardening: a tight default allowlist, the workspace's own test command allowed
// exactly, unsafe git options refused, and no agent edits inside .git folders.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import * as h from './helpers.ts'
import { defaultConfig } from '../src/config.ts'
import { isAllowlisted } from '../src/tools.ts'

after(() => h.running.close())

const defaults = defaultConfig().commandAllowlist

test('the default allowlist has no wildcards that run project code', () => {
  for (const risky of ['npm run build', 'npm run anything-the-agent-added', 'npx tsc --build', 'node --test x.js', 'go build ./...', 'cargo build', 'pytest', 'npm test']) {
    assert.equal(isAllowlisted(risky, defaults), false, risky)
  }
  for (const ok of ['git status', 'git status --short', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', 'git branch']) {
    assert.equal(isAllowlisted(ok, defaults), true, ok)
  }
})

test("a workspace's own test command is allowed exactly, variations are not", () => {
  const recipe = ['python -m unittest -v']
  assert.equal(isAllowlisted('python -m unittest -v', defaults, recipe), true)
  assert.equal(isAllowlisted('python  -m   unittest -v', defaults, recipe), true, 'whitespace differences are fine')
  assert.equal(isAllowlisted('python -m unittest -v other_module', defaults, recipe), false)
  assert.equal(isAllowlisted('python -m unittest -v & del x', defaults, recipe), false)
})

test('git options that write files or run programs always need approval', () => {
  for (const cmd of ['git diff --output=C:\\x.txt', 'git log --output=a', 'git diff --ext-diff', 'git status -c core.fsmonitor=evil', 'git log --exec=x']) {
    assert.equal(isAllowlisted(cmd, defaults), false, cmd)
  }
})

test('agents cannot change anything inside a .git folder, but can still read it', async () => {
  const t = await h.connect('full')
  mkdirSync(join(h.workspace, '.git'), { recursive: true })
  h.write(join(h.workspace, '.git', 'config'), '[core]\n\tbare = false\n')
  const read = await h.callTool(t.access_token, 'read_files', { files: [{ path: '.git/config' }] })
  assert.match(read.text, /bare = false/)
  const patch = '*** Begin Patch\n*** Update File: .git/config\n-\tbare = false\n+\tfsmonitor = evil.exe\n*** End Patch'
  assert.match((await h.callTool(t.access_token, 'apply_patch', { patch })).text, /inside a \.git folder/)
  const hook = await h.callTool(t.access_token, 'write_file', { path: '.git/hooks/pre-commit', content: 'evil' })
  assert.match(hook.text, /inside a \.git folder/)
  assert.equal(existsSync(join(h.workspace, '.git', 'hooks', 'pre-commit')), false)
})

test('the control page always shows that commands run in limits-only mode', async () => {
  const html = await (await fetch(`${h.CONTROL}/`)).text()
  assert.match(html, /Limits-only mode/)
})
