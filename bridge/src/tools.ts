// MCP tools. A fresh McpServer is built per request with the tool set of the caller's profile:
// `read-only` clients only ever see tools that change nothing on disk.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { audit } from './audit.ts'
import { createCheckpoint, getCheckpoint, listCheckpoints } from './checkpoints.ts'
import { homePath, type Config } from './config.ts'
import { fit, readOutput } from './outputs.ts'
import { parsePatch, PatchError } from './patch.ts'
import { applyPatchText, assertFreshRead, rememberRead } from './edits.ts'
import { redact } from './redact.ts'
import { needsReview, noteBaseline } from './review.ts'
import { createRun, getRun, killRun, listRuns, noteAgentWrite, recipeFor, startRun, waitForRun, type Run } from './runner.ts'
import { canonical, deniedReason, Scope, ScopeError, type Access } from './scope.ts'
import type { Profile, Store } from './store.ts'
import { sandboxStatus } from './sandbox.ts'

const require = createRequire(import.meta.url)
const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
const exec = promisify(execFile)

export type ToolContext = { config: Config; store: Store; scope: Scope; clientId: string; profile: Profile }

const SHELL_OPERATORS = /[&|;<>`^\r\n]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/

/** Options that make read-only git commands write files or run other programs. */
const UNSAFE_OPTIONS = /(^|\s)(--output\b|--ext-diff\b|--exec\b|--upload-pack\b|--receive-pack\b|-c\s|--config-env\b)/i

/**
 * Commands that run without approval: the workspace's own test commands (exactly as configured or
 * detected), plus allowlist patterns. Shell operators and unsafe options always need approval.
 */
export function isAllowlisted(command: string, allowlist: string[], recipeCommands: string[] = []): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ')
  if (SHELL_OPERATORS.test(cmd) || UNSAFE_OPTIONS.test(cmd)) return false
  if (recipeCommands.some((r) => r.trim().replace(/\s+/g, ' ').toLowerCase() === cmd.toLowerCase())) return true
  return allowlist.some((pattern) => {
    const re = new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^&|;<>`^]*')}$`, 'i')
    return re.test(cmd)
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

class ToolFailure extends Error {}

function refusedMessage(folder: string, askAgainAt: number): string {
  return `The user refused access to ${folder}. Work within the allowed folders (list_roots). You may ask again after ${new Date(askAgainAt).toISOString()}, or sooner if the user allows it on their control page.`
}

function describeRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    kind: run.kind,
    trigger: run.trigger,
    cwd: run.cwd,
    commands: run.commands,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    sandboxed: run.confined,
    sandbox: run.sandbox ?? null,
    problems: run.problems,
    tail: run.tail,
    fullLog: run.logChars ? `read_output handle "${run.id}" (${run.logChars} chars)` : null,
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 50 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    // git diff --no-index exits 1 when files differ.
    if (err.stdout) return err.stdout
    throw new ToolFailure(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`)
  }
}

export function buildServer(ctx: ToolContext): McpServer {
  const { config, store, scope, clientId, profile } = ctx
  const server = new McpServer(
    { name: 'harness-mcp', version: '0.1.0' },
    {
      instructions:
        'Tools to read, build on and test code on the user\'s computer. Start with workspace_info. ' +
        'Read files before changing them (apply_patch rejects edits to files you have not read). ' +
        'Values shown as [REDACTED:...] were masked before leaving the computer; never write them back. ' +
        'Commands outside the allowlist wait for the user to approve them locally; the call stays open while they decide, so just wait for its result. ' +
        'Work in a fix loop without stopping to ask: after changing code, check it (apply_patch with runTests: true, or run_tests); ' +
        'if tests fail, read the problems, fix the cause and test again. Stop when the tests pass, when the same failure repeats 3 times, ' +
        'or after 6 attempts, then summarise what changed and what still fails. ' +
        'Prefer test files run by the project test recipe over one-off "python -c"/"node -e" commands (shell quoting breaks them on Windows). ' +
        'Commands run in a sandbox by default: they can write only inside the workspace (.git is read-only) and network access is blocked ' +
        '(npm/pip installs, git fetch/push, downloads fail). If a command genuinely needs the network or to write elsewhere, call run with ' +
        'outsideSandbox: true and a justification; the user must approve that every time.',
    },
  )

  /** Name of the tool being run (one server handles one request), for automatic access requests. */
  let currentTool = ''

  type Handler<A> = (args: A) => Promise<unknown>
  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; input: S; write: boolean; destructive?: boolean },
    handler: Handler<z.infer<z.ZodObject<S>>>,
  ): void {
    if (meta.write && profile !== 'full') return
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: meta.input,
        annotations: { readOnlyHint: !meta.write, destructiveHint: meta.destructive ?? false, openWorldHint: false },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        const started = Date.now()
        currentTool = name
        if (store.state.mode !== 'on') {
          return { isError: true, content: [{ type: 'text' as const, text: 'The user has paused harness-mcp on their computer. Ask them to resume it.' }] }
        }
        try {
          const result = await handler(args)
          const { text: safe, hits } = redact(text(result))
          const out = fit(safe, config.limits.inlineChars)
          audit('tool', { clientId, tool: name, args, ms: Date.now() - started, redactions: hits, output: out })
          return { content: [{ type: 'text' as const, text: out }] }
        } catch (e) {
          const known = e instanceof ScopeError || e instanceof PatchError || e instanceof ToolFailure
          const message = known ? (e as Error).message : `Internal error: ${(e as Error).message}`
          audit('tool-error', { clientId, tool: name, args, error: message })
          return { isError: true, content: [{ type: 'text' as const, text: redact(message).text }] }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    )
  }

  const workspaceArg = z.string().optional().describe('Workspace folder (absolute, or relative to the active workspace). Defaults to the active workspace.')

  /**
   * Check a path; if it is outside the allowed folders (but not on the never-shared list), ask the
   * user for access to its folder and wait, inside this call, for the decision.
   */
  async function allow(path: string, access: Access, base?: string): Promise<string> {
    try {
      return scope.check(path, access, base)
    } catch (e) {
      if (!(e instanceof ScopeError) || !e.outside) throw e
      if (access === 'write' && profile !== 'full') throw e
      const target = e.outside.path
      const folder = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target)
      const same = (a: { detail: Record<string, unknown> }) => String(a.detail.path).toLowerCase() === folder.toLowerCase()
      const refusal = store.refusalFor(clientId, folder)
      if (refusal) throw new ToolFailure(refusedMessage(folder, refusal.askAgainAt))
      let action = store.state.actions.find((a) => a.kind === 'access' && a.status === 'pending' && a.clientId === clientId && same(a) && (a.detail.mode === access || a.detail.mode === 'write'))
      if (!action) {
        const waiting = store.state.actions.filter((a) => a.kind === 'access' && a.status === 'pending' && a.clientId === clientId)
        if (waiting.length >= 3) throw new ToolFailure(`${target} is outside the allowed folders, and 3 access requests are already waiting for the user.`)
        action = store.addAction({
          kind: 'access',
          clientId,
          summary: `${access} access to ${folder}`,
          detail: { path: folder, mode: access, reason: `Needed to ${currentTool.replace(/_/g, ' ')} ${target}`, durationHours: null, automatic: true },
        })
        audit('access-request', { clientId, path: folder, mode: access, automatic: true, tool: currentTool })
      }
      const decided = await store.waitForAction(action.id, config.limits.toolWaitSec * 1000)
      if (decided?.status === 'approved') return scope.check(path, access, base)
      if (decided?.status === 'denied') throw new ToolFailure(`The user refused ${access} access to ${folder}. Work within the allowed folders (list_roots).`)
      throw new ToolFailure(`${target} is outside the folders you may ${access}. The user has been asked to allow it; call get_access_request with id "${action.id}" and retry once it is approved.`)
    }
  }

  async function resolveWorkspace(ws: string | undefined, access: 'read' | 'write'): Promise<string> {
    if (ws) return allow(ws, access)
    const active = scope.activeWorkspace()
    if (!active) throw new ToolFailure('No workspace is configured. Call list_roots, then set_workspace or request_access.')
    return allow(active, access)
  }

  // ------------------------------------------------------------------ read tools

  tool(
    'workspace_info',
    {
      title: 'Workspace overview',
      description: 'Overview of a workspace: path, git branch and status, top-level files, detected stack and test recipe. Call this first.',
      input: { workspace: workspaceArg },
      write: false,
    },
    async ({ workspace }) => {
      const ws = await resolveWorkspace(workspace, 'read')
      const entries = readdirSync(ws, { withFileTypes: true })
        .filter((d) => !deniedReason(join(ws, d.name), config))
        .slice(0, 200)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      const isGit = existsSync(join(ws, '.git'))
      return {
        workspace: ws,
        activeWorkspace: scope.activeWorkspace(),
        yourProfile: profile,
        git: isGit ? (await git(ws, ['status', '--porcelain=v1', '--branch'])).trim() : 'not a git repository',
        topLevel: entries,
        testRecipe: recipeFor(ws, config),
        stackHints: ['package.json', 'composer.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile']
          .filter((f) => existsSync(join(ws, f)))
          .concat(readdirSync(ws).filter((f) => /\.(sln|csproj)$/i.test(f))),
      }
    },
  )

  tool(
    'list_roots',
    {
      title: 'List allowed folders',
      description: 'Folders this agent may read, folders it may write to, and active temporary grants.',
      input: {},
      write: false,
    },
    async () => ({
      readRoots: scope.readRoots(),
      writeRoots: profile === 'full' ? scope.writeRoots() : [],
      activeWorkspace: scope.activeWorkspace(),
      grants: store.activeGrants().map((g) => ({ path: g.path, mode: g.mode, expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : 'end of session' })),
      note: 'Secret-bearing files (.env, keys, configuration.php, credential stores) are never readable, even inside these roots.',
    }),
  )

  tool(
    'find_files',
    {
      title: 'Find files',
      description: 'List files under a folder, optionally filtered by a glob such as "**/*.php". Respects .gitignore.',
      input: {
        path: z.string().optional().describe('Folder to search. Defaults to the active workspace.'),
        glob: z.string().optional().describe('Glob filter, e.g. "src/**/*.ts".'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum files to return (default 500).'),
      },
      write: false,
    },
    async ({ path, glob, limit }) => {
      const root = path ? await allow(path, 'read') : await resolveWorkspace(undefined, 'read')
      const args = ['--files', '--hidden', '--glob', '!.git']
      if (glob) args.push('--glob', glob)
      args.push(root)
      const { stdout } = await exec(rgPath, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }).catch((e) => ({ stdout: (e as { stdout?: string }).stdout ?? '' }))
      const files = stdout.split(/\r?\n/).filter((f) => f && !deniedReason(f, config))
      const max = limit ?? 500
      return { root, total: files.length, files: files.slice(0, max).map((f) => f.slice(root.length + 1)), truncated: files.length > max }
    },
  )

  tool(
    'read_files',
    {
      title: 'Read files',
      description: 'Read up to 20 text files (or line ranges) in one call. Lines are numbered as "N\\t" — the number and tab are not part of the file. Reading a file is required before editing it.',
      input: {
        files: z
          .array(
            z.object({
              path: z.string().describe('File path, absolute or relative to the active workspace.'),
              startLine: z.number().int().min(1).optional(),
              endLine: z.number().int().min(1).optional(),
            }),
          )
          .min(1)
          .max(20),
      },
      write: false,
    },
    async ({ files }) => {
      const results: string[] = []
      for (const f of files) {
        try {
          const p = await allow(f.path, 'read')
          const st = statSync(p)
          if (st.isDirectory()) throw new ToolFailure(`${p} is a directory; use find_files.`)
          if (st.size > config.limits.maxReadBytes) throw new ToolFailure(`${p} is ${st.size} bytes, above the ${config.limits.maxReadBytes}-byte limit; read a line range instead.`)
          const raw = readFileSync(p)
          if (raw.subarray(0, 8000).includes(0)) throw new ToolFailure(`${p} looks binary; not shown.`)
          rememberRead(clientId, p, raw)
          const lines = raw.toString('utf8').split(/\r?\n/)
          const start = (f.startLine ?? 1) - 1
          const end = Math.min(f.endLine ?? lines.length, lines.length)
          const body = lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n')
          const { text: safe, hits } = redact(body)
          const note = Object.keys(hits).length ? `\n[note: ${Object.values(hits).reduce((a, b) => a + b, 0)} secret value(s) masked before sending; do not write [REDACTED:...] placeholders back]` : ''
          results.push(`=== ${p} (lines ${start + 1}-${end} of ${lines.length})${note}\n${body}`)
        } catch (e) {
          results.push(`=== ${f.path}\nERROR: ${(e as Error).message}`)
        }
      }
      return results.join('\n\n')
    },
  )

  tool(
    'search',
    {
      title: 'Search code',
      description: 'Search file contents with ripgrep (regular expression by default). Returns matches with file:line and optional context.',
      input: {
        query: z.string().min(1),
        path: z.string().optional().describe('Folder or file to search. Defaults to the active workspace.'),
        glob: z.string().optional().describe('Limit to files matching a glob, e.g. "*.php".'),
        literal: z.boolean().optional().describe('Treat the query as plain text, not a regex.'),
        caseSensitive: z.boolean().optional(),
        context: z.number().int().min(0).max(10).optional().describe('Lines of context around each match (default 0).'),
        maxResults: z.number().int().min(1).max(1000).optional().describe('Default 200.'),
      },
      write: false,
    },
    async ({ query, path, glob, literal, caseSensitive, context, maxResults }) => {
      const root = path ? await allow(path, 'read') : await resolveWorkspace(undefined, 'read')
      const args = ['--json', '--hidden', '--glob', '!.git', caseSensitive ? '--case-sensitive' : '--smart-case']
      if (literal) args.push('--fixed-strings')
      if (glob) args.push('--glob', glob)
      if (context) args.push('-C', String(context))
      args.push('--', query, root)
      const { stdout } = await exec(rgPath, args, { maxBuffer: 100 * 1024 * 1024, windowsHide: true }).catch((e) => ({ stdout: (e as { stdout?: string }).stdout ?? '' }))
      const max = maxResults ?? 200
      const out: string[] = []
      let matches = 0
      const deniedCache = new Map<string, boolean>()
      for (const line of stdout.split('\n')) {
        if (!line) continue
        const msg = JSON.parse(line) as { type: string; data: { path?: { text: string }; line_number?: number; lines?: { text: string } } }
        if (msg.type !== 'match' && msg.type !== 'context') continue
        const file = msg.data.path?.text ?? ''
        if (!deniedCache.has(file)) deniedCache.set(file, deniedReason(file, config) !== null)
        if (deniedCache.get(file)) continue
        if (msg.type === 'match' && ++matches > max) break
        const rel = file.startsWith(root) ? file.slice(root.length + 1) : file
        out.push(`${rel}:${msg.data.line_number}${msg.type === 'match' ? ':' : '-'} ${(msg.data.lines?.text ?? '').replace(/\r?\n$/, '')}`)
      }
      return out.length ? `${Math.min(matches, max)} match(es) under ${root}${matches > max ? ' (truncated)' : ''}\n${out.join('\n')}` : `No matches under ${root}.`
    },
  )

  tool(
    'git_diff',
    {
      title: 'Show changes',
      description: 'Show uncommitted changes in a git workspace (or staged changes), or what changed since a checkpoint.',
      input: {
        workspace: workspaceArg,
        staged: z.boolean().optional(),
        checkpoint: z.string().optional().describe('Checkpoint id from list_checkpoints: show changes since it was taken.'),
      },
      write: false,
    },
    async ({ workspace, staged, checkpoint }) => {
      const ws = await resolveWorkspace(workspace, 'read')
      if (checkpoint) {
        const cp = getCheckpoint(checkpoint)
        if (!cp) throw new ToolFailure(`Unknown checkpoint ${checkpoint}.`)
        const parts: string[] = []
        for (const f of cp.files) {
          await allow(f.path, 'read')
          const empty = process.platform === 'win32' ? 'NUL' : '/dev/null'
          const before = f.existed && f.blob ? homePath('checkpoints', cp.id, f.blob) : empty
          const after = existsSync(f.path) ? f.path : empty
          parts.push(`### ${f.path}\n${await git(ws, ['diff', '--no-index', '--no-color', '--', before, after]) || '(no change)'}`)
        }
        return parts.join('\n')
      }
      if (!existsSync(join(ws, '.git'))) throw new ToolFailure(`${ws} is not a git repository; use the checkpoint option instead.`)
      const args = ['diff', '--no-color']
      if (staged) args.push('--cached')
      const stat = await git(ws, [...args, '--stat'])
      const diff = await git(ws, args)
      return diff ? `${stat}\n${diff}` : 'No changes.'
    },
  )

  tool(
    'list_runs',
    { title: 'List runs', description: 'Recent test and command runs with their status.', input: { limit: z.number().int().min(1).max(100).optional() }, write: false },
    async ({ limit }) => listRuns(limit ?? 15).map((r) => ({ id: r.id, status: r.status, kind: r.kind, trigger: r.trigger, commands: r.commands, finishedAt: r.finishedAt, problems: r.problems.length })),
  )

  tool(
    'get_run',
    {
      title: 'Get run result',
      description: 'Result of a test/command run: status, exit code, failure lines with file:line, and the last lines of output. Use id "latest" for the most recent run. Waits up to waitSec for a running run.',
      input: { id: z.string().describe('Run id, or "latest".'), waitSec: z.number().int().min(0).max(100).optional() },
      write: false,
    },
    async ({ id, waitSec }) => {
      const run = getRun(id)
      if (!run) throw new ToolFailure(`No run ${id}. Call list_runs.`)
      return describeRun(await waitForRun(run, (waitSec ?? 0) * 1000))
    },
  )

  tool(
    'read_output',
    {
      title: 'Read stored output',
      description: 'Page through a full run log or a long output that was shortened, using its handle.',
      input: { handle: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100_000).optional() },
      write: false,
    },
    async ({ handle, offset, limit }) => {
      const r = readOutput(handle, offset ?? 0, limit ?? 30_000)
      if (!r) throw new ToolFailure(`Unknown handle ${handle}.`)
      const end = (offset ?? 0) + r.text.length
      return `[chars ${offset ?? 0}-${end} of ${r.total}${end < r.total ? `; next offset ${end}` : ''}]\n${r.text}`
    },
  )

  tool(
    'list_checkpoints',
    { title: 'List checkpoints', description: 'Checkpoints taken before each change, newest first.', input: {}, write: false },
    async () => listCheckpoints(20).map((c) => ({ id: c.id, createdAt: c.createdAt, reason: c.reason, files: c.files.map((f) => f.path) })),
  )

  tool(
    'request_access',
    {
      title: 'Ask for folder access',
      description: 'Ask the user to grant read or write access to another folder. The user approves on their computer; poll get_access_request for the decision.',
      input: {
        path: z.string(),
        mode: z.enum(['read', 'write']).describe('write also allows running commands there.'),
        reason: z.string().min(5).max(500),
        durationHours: z.number().min(0.25).max(24).optional().describe('Omit for "until the server restarts".'),
      },
      write: true,
    },
    async ({ path, mode, reason, durationHours }) => {
      const p = canonical(path)
      const denied = deniedReason(p, config)
      if (denied) throw new ToolFailure(`Cannot grant ${p}: ${denied}.`)
      const pending = store.state.actions.filter((a) => a.kind === 'access' && a.status === 'pending' && a.clientId === clientId)
      if (pending.length >= 3) throw new ToolFailure('There are already 3 access requests waiting for the user.')
      const refusal = store.refusalFor(clientId, p)
      if (refusal) throw new ToolFailure(refusedMessage(p, refusal.askAgainAt))
      const action = store.addAction({ kind: 'access', clientId, summary: `${mode} access to ${p}`, detail: { path: p, mode, reason, durationHours: durationHours ?? null } })
      audit('access-request', { clientId, path: p, mode, reason })
      const decided = await store.waitForAction(action.id, config.limits.toolWaitSec * 1000)
      if (decided?.status === 'approved') return { requestId: action.id, status: 'approved', roots: { read: scope.readRoots(), write: scope.writeRoots() } }
      if (decided?.status === 'denied') return { requestId: action.id, status: 'denied' }
      return { requestId: action.id, status: 'pending', message: 'The user has not decided yet. Poll get_access_request.' }
    },
  )

  tool(
    'get_access_request',
    { title: 'Check access request', description: 'Status of an access request or other approval (pending, approved, denied).', input: { id: z.string() }, write: false },
    async ({ id }) => {
      const a = store.state.actions.find((x) => x.id === id && x.clientId === clientId)
      if (!a) throw new ToolFailure(`No request ${id}.`)
      return { id: a.id, kind: a.kind, status: a.status, summary: a.summary }
    },
  )

  // ------------------------------------------------------------------ write tools (full profile)

  tool(
    'set_workspace',
    { title: 'Switch workspace', description: 'Make another writable folder the active workspace.', input: { path: z.string() }, write: true },
    async ({ path }) => {
      const p = await allow(path, 'write')
      store.state.activeWorkspace = p
      store.save()
      return { activeWorkspace: p, testRecipe: recipeFor(p, config) }
    },
  )

  tool(
    'apply_patch',
    {
      title: 'Apply patch',
      description:
        'Create, edit, move or delete files using the apply_patch format:\n' +
        '*** Begin Patch\n*** Add File: path\n+line\n*** Update File: path\n[*** Move to: new/path]\n@@ optional context header\n context\n-old\n+new\n*** Delete File: path\n*** End Patch\n' +
        'Paths are relative to the workspace. Files being updated or deleted must have been read first. A checkpoint is taken before changes, so they can be reverted.',
      input: {
        patch: z.string().min(1),
        workspace: workspaceArg,
        runTests: z.boolean().optional().describe("Also run the workspace's test recipe after applying and include the result (saves a call)."),
      },
      write: true,
      destructive: true,
    },
    async ({ patch, workspace, runTests }) => {
      const ws = await resolveWorkspace(workspace, 'write')
      for (const op of parsePatch(patch)) {
        await allow(op.path, 'write', ws)
        if (op.kind === 'update' && op.moveTo) await allow(op.moveTo, 'write', ws)
      }
      const applied = applyPatchText(patch, ws, scope, clientId, true)
      if (!runTests) return { ...applied, next: 'Call run_tests (or pass runTests: true next time) to check the change.' }
      const recipe = recipeFor(ws, config)
      if (!recipe) return { ...applied, tests: 'No test recipe configured or detected for this workspace; use run with a specific command.' }
      return { ...applied, tests: await execute({ kind: 'tests', cwd: ws, commands: recipe.commands }, testsNeedReview(ws)) }
    },
  )

  tool(
    'write_file',
    {
      title: 'Write file',
      description: 'Create a file, or replace a whole file you have read. Prefer apply_patch for edits to existing files.',
      input: { path: z.string(), content: z.string(), workspace: workspaceArg },
      write: true,
      destructive: true,
    },
    async ({ path, content, workspace }) => {
      if (content.includes('[REDACTED:')) throw new PatchError('The content contains a [REDACTED:...] placeholder; masked values must not be written back.')
      const ws = await resolveWorkspace(workspace, 'write')
      const p = await allow(path, 'write', ws)
      if (existsSync(p)) assertFreshRead(clientId, p)
      const cp = createCheckpoint([p], clientId, `write_file ${basename(p)}`)
      mkdirSync(dirname(p), { recursive: true })
      noteAgentWrite([p])
      noteBaseline([p])
      writeFileSync(p, content)
      rememberRead(clientId, p, readFileSync(p))
      return { wrote: p, bytes: Buffer.byteLength(content), checkpoint: cp.id }
    },
  )

  type RunInit = Pick<Run, 'kind' | 'cwd' | 'commands'> & { outsideSandbox?: boolean; justification?: string }

  /** Start a run now, or (ask) hold the call open while the user approves it on the control page. */
  async function execute(init: RunInit, ask: boolean): Promise<Record<string, unknown>> {
    const run = createRun({ ...init, trigger: 'agent', clientId }, ask)
    if (!ask) void startRun(run, config)
    else {
      const command = init.commands.join(' && ')
      const action = store.addAction({
        kind: 'command',
        clientId,
        summary: command,
        detail: { runId: run.id, cwd: init.cwd, tests: init.kind === 'tests', outsideSandbox: !!init.outsideSandbox, justification: init.justification ?? null, sandbox: sandboxStatus().mode },
      })
      audit('command-pending', { clientId, command, cwd: init.cwd, actionId: action.id })
    }
    // The agent gets the result in this same call, including any wait for the user.
    const settled = await waitForRun(run, config.limits.toolWaitSec * 1000)
    const result = describeRun(settled)
    if (settled.status === 'awaiting-approval') {
      result.note = `${init.kind === 'tests' ? 'This workspace is untrusted, so tests on your changes need' : 'Not on the allowlist, so it needs'} the user's approval, and they have not decided yet. Call get_run with id "${run.id}" and waitSec 60 to keep waiting.`
    } else if (settled.status === 'denied') {
      result.note = 'The user refused this run. Do not retry it; choose another approach or ask the user.'
    } else if (settled.status === 'running') {
      result.note = `Still running. Call get_run with id "${run.id}" and waitSec to wait for it.`
    }
    return result
  }

  const testsNeedReview = (ws: string) => needsReview(ws, config, store, scope)

  tool(
    'run_tests',
    {
      title: 'Run tests',
      description: "Run the workspace's test/build recipe in the sandbox and return the result (failures with file:line). Long runs continue in the background; poll get_run.",
      input: { workspace: workspaceArg },
      write: true,
    },
    async ({ workspace }) => {
      const ws = await resolveWorkspace(workspace, 'write')
      const recipe = recipeFor(ws, config)
      if (!recipe) throw new ToolFailure('No test recipe configured or detected for this workspace. Use run with a specific command, or ask the user to add a recipe.')
      return execute({ kind: 'tests', cwd: ws, commands: recipe.commands }, testsNeedReview(ws))
    },
  )

  tool(
    'run',
    {
      title: 'Run command',
      description:
        'Run one command (cmd.exe syntax on Windows) with cwd inside a writable workspace. It runs in the sandbox: writes only inside the workspace (.git read-only), ' +
        'network blocked. Read-only git commands and the workspace test command run immediately; anything else waits for the user to approve it on their computer — ' +
        'the call stays open while they decide and returns the result. Set outsideSandbox (with a justification) only when the command needs the network or to write ' +
        "outside the workspace, such as installing packages; that always needs the user's approval. Prefer run_tests for tests.",
      input: {
        command: z.string().min(1).max(4000),
        cwd: z.string().optional().describe('Working directory; defaults to the active workspace.'),
        outsideSandbox: z.boolean().optional().describe("Run with the user's full rights and network access. Always requires the user's approval."),
        justification: z.string().max(500).optional().describe('Why the command must run outside the sandbox (shown to the user).'),
      },
      write: true,
      destructive: true,
    },
    async ({ command, cwd, outsideSandbox, justification }) => {
      const dir = cwd ? await allow(cwd, 'write') : await resolveWorkspace(undefined, 'write')
      if (outsideSandbox) {
        if (!justification) throw new ToolFailure('Explain why the command must run outside the sandbox (justification).')
        return execute({ kind: 'command', cwd: dir, commands: [command], outsideSandbox: true, justification }, true)
      }
      // The workspace's own test command runs code the agent wrote, so it follows the workspace's trust.
      const isRecipe = isAllowlisted(command, [], recipeFor(dir, config)?.commands ?? [])
      const auto = isAllowlisted(command, config.commandAllowlist) || (isRecipe && !testsNeedReview(dir))
      return execute({ kind: 'command', cwd: dir, commands: [command] }, !auto)
    },
  )

  tool(
    'kill_run',
    { title: 'Stop run', description: 'Stop a running run and its whole process tree.', input: { id: z.string() }, write: true },
    async ({ id }) => ({ stopped: killRun(id) }),
  )

  tool(
    'revert_checkpoint',
    {
      title: 'Revert to checkpoint',
      description: 'Ask to restore files to how they were before a checkpoint. The user approves on their computer.',
      input: { id: z.string() },
      write: true,
      destructive: true,
    },
    async ({ id }) => {
      const cp = getCheckpoint(id)
      if (!cp) throw new ToolFailure(`Unknown checkpoint ${id}.`)
      const action = store.addAction({ kind: 'revert', clientId, summary: `revert ${cp.files.length} file(s) to ${cp.id}`, detail: { checkpoint: cp.id } })
      const decided = await store.waitForAction(action.id, config.limits.toolWaitSec * 1000)
      if (decided?.status === 'approved') return { requestId: action.id, status: 'approved', restored: decided.detail.restored ?? [] }
      if (decided?.status === 'denied') return { requestId: action.id, status: 'denied' }
      return { requestId: action.id, status: 'pending', message: 'The user has not decided yet. Poll get_access_request.' }
    },
  )

  return server
}
