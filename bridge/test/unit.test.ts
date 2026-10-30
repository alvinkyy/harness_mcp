import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyHunks, parsePatch, type FileOp } from '../src/patch.ts'
import { redact } from '../src/redact.ts'
import { isAllowlisted } from '../src/tools.ts'

test('patch: CRLF files keep CRLF and fuzzy whitespace matching works', () => {
  const ops = parsePatch('*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two  \n+TWO\n*** End Patch')
  assert.equal(ops[0].kind, 'update')
  const out = applyHunks('one\r\ntwo\r\nthree\r\n', (ops[0] as Extract<FileOp, { kind: 'update' }>).hunks, 'a.txt')
  assert.equal(out, 'one\r\nTWO\r\nthree\r\n')
})

test('patch: End of File anchors at the end', () => {
  const ops = parsePatch('*** Begin Patch\n*** Update File: a\n x\n+y\n*** End of File\n*** End Patch')
  assert.equal(applyHunks('x\nmid\nx\n', (ops[0] as Extract<FileOp, { kind: 'update' }>).hunks, 'a'), 'x\nmid\nx\ny\n')
})

test('patch: malformed input is rejected', () => {
  assert.throws(() => parsePatch('*** Update File: a\n-x'))
  assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch'))
})

test('redact: ordinary code is left intact', () => {
  const code = "const token = req.headers.authorization\nif (password.length < 12) throw err\n$key = getenv('API_KEY');"
  assert.equal(redact(code).text, code)
})

test('redact: placeholders and non-Luhn numbers are not masked', () => {
  const s = "api_key = 'your-api-key-here'\norder 1234567890123456"
  assert.equal(redact(s).text, s)
})

test('allowlist: wildcards stop at shell operators', () => {
  const list = ['npm test', 'npm run *', 'git log *']
  assert.ok(isAllowlisted('npm test', list))
  assert.ok(isAllowlisted('npm run build -- --prod', list))
  assert.ok(!isAllowlisted('npm run build && del x', list))
  assert.ok(!isAllowlisted('git log ; rm -rf /', list))
  assert.ok(!isAllowlisted('curl http://x', list))
})
