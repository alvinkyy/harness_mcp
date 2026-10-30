// Parser and applier for the Codex apply_patch format:
//
//   *** Begin Patch
//   *** Add File: path            (every following line starts with +)
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: new/path         (optional, right after Update File)
//   @@ optional context header
//    context line                 (leading space)
//   -removed line
//   +added line
//   *** End of File               (optional: the hunk is anchored at the end of the file)
//   *** End Patch

export type Hunk = { header: string; lines: { op: ' ' | '-' | '+'; text: string }[]; endOfFile: boolean }

export type FileOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] }

export class PatchError extends Error {}

export function parsePatch(patch: string): FileOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() !== '*** Begin Patch') throw new PatchError('Patch must start with "*** Begin Patch".')
  i++
  const ops: FileOp[] = []
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '*** End Patch') return ops
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      i++
      const body: string[] = []
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new PatchError(`Add File ${path}: every content line must start with "+".`)
        body.push(lines[i].slice(1))
        i++
      }
      ops.push({ kind: 'add', path, content: body.join('\n') + (body.length ? '\n' : '') })
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      ops.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() })
      i++
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      i++
      let moveTo: string | undefined
      if (lines[i]?.startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim()
        i++
      }
      const hunks: Hunk[] = []
      let current: Hunk | null = null
      while (i < lines.length && !(lines[i].startsWith('*** ') && lines[i].trim() !== '*** End of File')) {
        const l = lines[i]
        if (l.startsWith('@@')) {
          current = { header: l.slice(2).trim(), lines: [], endOfFile: false }
          hunks.push(current)
        } else if (l.trim() === '*** End of File') {
          if (current) current.endOfFile = true
        } else {
          if (!current) {
            current = { header: '', lines: [], endOfFile: false }
            hunks.push(current)
          }
          const op = l[0]
          if (op === ' ' || op === '-' || op === '+') current.lines.push({ op, text: l.slice(1) })
          else if (l === '') current.lines.push({ op: ' ', text: '' })
          else throw new PatchError(`Update File ${path}: line must start with " ", "-", "+" or "@@": ${JSON.stringify(l)}`)
        }
        i++
      }
      if (!hunks.length && !moveTo) throw new PatchError(`Update File ${path}: no hunks.`)
      ops.push({ kind: 'update', path, moveTo, hunks })
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    throw new PatchError(`Unexpected line: ${JSON.stringify(line)}`)
  }
  throw new PatchError('Patch must end with "*** End Patch".')
}

/** Find `needle` in `hay` starting at `from`, trying exact, then trailing-whitespace-insensitive, then trimmed. */
function seek(hay: string[], needle: string[], from: number, eof: boolean): number {
  const passes: ((s: string) => string)[] = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()]
  for (const f of passes) {
    const start = eof ? Math.max(from, hay.length - needle.length) : from
    for (let i = start; i <= hay.length - needle.length; i++) {
      let ok = true
      for (let j = 0; j < needle.length; j++) {
        if (f(hay[i + j]) !== f(needle[j])) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
  }
  return -1
}

/** Apply update hunks to file text, preserving its line endings. */
export function applyHunks(original: string, hunks: Hunk[], path: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = original.endsWith('\n')
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  if (hadFinalNewline) lines.pop()
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.header) {
      const h = seek(lines, [hunk.header], cursor, false)
      if (h >= 0) cursor = h + 1
    }
    const before = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text)
    const after = hunk.lines.filter((l) => l.op !== '-').map((l) => l.text)
    let at: number
    if (before.length === 0) {
      at = hunk.endOfFile ? lines.length : cursor
    } else {
      at = seek(lines, before, cursor, hunk.endOfFile)
      if (at < 0) at = seek(lines, before, 0, hunk.endOfFile)
      if (at < 0) {
        throw new PatchError(
          `Update File ${path}: could not find the context/removed lines:\n${before.slice(0, 6).join('\n')}\nRe-read the file and regenerate the patch.`,
        )
      }
    }
    lines.splice(at, before.length, ...after)
    cursor = at + after.length
  }
  return lines.join(eol) + (hadFinalNewline ? eol : '')
}
