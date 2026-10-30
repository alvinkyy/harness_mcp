# harness-mcp — design (v4, as built)

A local MCP server that lets **web-interface agents with remote MCP connectors** read your code on
this PC, build on it and test it from the browser: claude.ai, ChatGPT, and any other agent that
implements the standard. The agent's model does the thinking. This PC does the reading, writing,
patching and testing, and **you approve anything risky on a page only this PC can open**.

Code: [`bridge/`](bridge/README.md) (setup and usage). Status and open work: §8.

## 1. Topology

```
claude.ai · ChatGPT · other MCP web agents
  │ HTTPS + OAuth 2.1 (standard MCP Streamable HTTP)
  ▼
Cloudflare quick tunnel  https://<random-words>.trycloudflare.com   (address changes each start)
  │ cloudflared, started and supervised by harness-mcp (tunnel.mode "quick")
  ▼
harness-mcp  127.0.0.1:8787   OAuth endpoints · sign-in pages · /mcp
  ├─ profile per client: read-only | full
  ├─ tools (§4) · runner (apply → test → record run) · checkpoints
  ├─ scope + automatic access requests · redaction · Job Object sandbox · audit log
  └─ control page 127.0.0.1:8788 (loopback only, never tunnelled)
```

- **Changing address.** The quick-tunnel hostname changes on every start. With `publicUrl: "auto"`,
  the OAuth issuer and resource URLs are taken from each request's Host header, accepted only for
  `publicHosts` (default `*.trycloudflare.com`; anything else gets 421). The control page shows the
  current connector address with Copy, and warns when it changed.
  - Each change means updating the connector in each chat app.
  - A named tunnel on your own domain (`publicUrl: "https://…"`) would fix this. No domain is
    available today, so quick tunnels stay.
- **No secret in the address.** Access comes only from sign-in (§5.1).

## 2. Platform constraints

- **ChatGPT plans.** Per OpenAI's help center, full MCP (write tools) is for Business and
  Enterprise/Edu, and Pro is described as read/fetch only. The 2026-10-28 probe showed ChatGPT
  (`openai-mcp 1.0.0`) listing and calling an honestly labelled write tool on the account tested.
  Every tool is labelled honestly (`readOnlyHint`), and the read-only profile is useful on its own,
  with paste-to-apply on the control page as the fallback.
- **The chat app's own UI is outside our control,** e.g. ChatGPT's **+** / **…** / "Continue
  connecting app". The server can only refuse access until sign-in completes, and end every sign-in
  with an explicit answer (§5.1).
- **Request deadlines.** Cloudflare drops responses slower than 100 s, so tool calls wait at most
  `limits.toolWaitSec` (85 s). Longer runs continue in the background, and the agent collects them
  with `get_run`.
- **Use.** Personal projects only. Not for Exabytes company code (owner's decision).

## 3. The fix loop

```
agent: workspace_info → read_files / search → apply_patch {runTests: true}
PC:    checkpoint → apply → run the workspace's test recipe in the sandbox → digest failures
agent: reads failures (file:line, last lines) → next patch … until tests pass,
       the same failure repeats 3×, or 6 attempts — then summarises
```

- **The loop is in the server instructions,** so agents keep going without asking between steps.
- **Approvals happen inside the call.** A non-allowlisted command, a revert or an access request
  keeps the tool call open while you decide on the control page (beep plus desktop notification),
  then returns the result in that same call.
- **Test recipes** per workspace (configured, or detected from `package.json`, `composer.json`,
  `test_*.py`, `go.mod`, …). In a trusted workspace recipe commands run without clicks; in an
  untrusted one they wait for approval while there are unseen agent changes (§5.4).
- **Watch mode** (`"watch": true`) reruns tests on your own edits. It skips files the agent just
  wrote, because the agent tests those itself.
- **Read-only fallback:** the agent proposes a patch, you paste it on the control page and click
  **Apply and run tests**, and the agent reads `get_run latest`.

## 4. Tools

| Profile | Tools |
|---|---|
| **read-only** (every client) | `workspace_info`, `list_roots`, `find_files`, `read_files`, `search`, `git_diff`, `list_runs`, `get_run`, `read_output`, `list_checkpoints`, `get_access_request` |
| **full** (adds) | `apply_patch` (Codex format, add/update/move/delete, optional `runTests`), `write_file`, `run_tests`, `run`, `kill_run`, `revert_checkpoint`, `request_access`, `set_workspace` |

- **Read-before-write:** an edit is refused if the agent hasn't read the file, or the file changed
  since it did. This also stops two agents from overwriting each other.
- **Checkpoints** are saved before every change, and can be undone from the control page.
- **Long output** is cut to head and tail, with a handle for `read_output`.

## 5. Security

### 5.1 Connecting: proving it's you
1. **Sign-in page:** passphrase plus authenticator code (TOTP), rate-limited, locked for 15 min after
   5 failures.
2. **Local approval:** Continue opens the control page's approval card in a new tab. You choose
   read-only or full and click **Allow connection**. The tab closes, and the sign-in tab returns to
   the chat app. The control page is loopback-only, so nobody remote can approve.
3. **Explicit endings:** Cancel, Refuse, a 2-minute timeout and lockout all send the chat app
   `error=access_denied` with a reason, never a silent stall. Back, Forward and Reload resume the
   current step (post/redirect/get, back-cache reload).
4. **Clients:** any agent may register (HTTPS redirect URIs, plus `http://localhost` for local
   tools). Nothing is granted until a connection is allowed locally. New clients default to
   read-only.
5. **Tokens:** 15-minute access tokens, rotating refresh tokens (reuse revokes the client),
   2-hour idle disconnect, per-client Revoke, and Disconnect all.
6. **Outside this design:** whoever controls your chat account *is* you to the server. Use MFA on
   those accounts.

### 5.2 File scope
| Scope | Default | Notes |
|---|---|---|
| **Read** | `readRoots` (`Desktop\Project`) plus workspaces | Anything else triggers an **automatic access request** for its folder |
| **Write** (edits, commands' cwd) | `workspaces` (`testing_folder`) | Outside writes trigger an automatic **write** request (full profile only) |
| **Never shared** | `.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.npmrc`, `.env*`, keys/certs, `configuration.php`, `wp-config.php`, credential/secret files, browser profiles, Windows credential stores, Outlook data, `C:\Windows`, other users' profiles | No request is possible; extend with `extraDeny`, never reduce remotely |

- **Requests wait inside the call.** You can **narrow** them on the approval card (pick a subfolder,
  downgrade write to read, or set hours).
- **Limits:** at most 3 pending requests per client. A refused folder isn't asked about again that
  session.
- **Grants** last until restart or the hours chosen, and can be revoked on the Folders page.
- **Paths are canonicalized** before every check, with symlinks and junctions resolved.

### 5.3 Redaction
Every outgoing payload passes through redaction: file reads, search results, command output and
errors.
- **Masked:** private keys, cloud/API tokens, JWTs, bearer tokens, connection-string passwords,
  quoted secret assignments, env-style secrets, and Luhn-valid card numbers (last 4 kept).
- **No write-back:** patches or files containing `[REDACTED:…]` are refused, so masked values are
  never written back.
- **Personal data (emails, phones, IC numbers) is not masked.** That was decided out of scope: this
  tool won't be used on customer data.

### 5.4 Commands
- **Approval:** only these run without asking:
  - read-only git commands (`git status`, `log`, `diff`, `show`, `branch`);
  - each workspace's own test command, exactly as configured or detected, **if the workspace is
    trusted or has no unseen agent changes**.

  Wildcards like `npm run *` are deliberately not in the default allowlist, because the agent can
  edit `package.json`. Shell operators (`& | ; < > ^ %VAR%`) and git options that write files or run
  programs (`--output`, `--ext-diff`, `-c`, …) always need approval. Everything else waits for your
  click, inside the call.
- **Trusted and untrusted workspaces:** folders in `workspaces` start trusted, folders shared on
  request start untrusted, and the Folders page switches either. harness-mcp remembers each file's
  content before the first agent change since your last approval in that workspace
  (`review.json`). In an untrusted workspace, test runs (`run_tests`, `apply_patch` with
  `runTests`, the recipe command through `run`, and watch mode) wait for your approval while any
  such change exists. Patches you paste yourself don't count.
- **Approval cards** for commands list those unseen changes with a diff. Approving counts them as
  seen; so does **Mark as seen**.
- **No agent edits inside `.git`:** hooks or settings there could make plain `git status` run a
  program.
- **The control page always shows** a "Limits-only mode" strip.
- **Limits-only mode (by decision; no write-confining sandbox):** a Job Object (whole-tree kill on
  timeout, memory and CPU caps) and a scrubbed environment.
- **What this does not cover:** commands run with your full user rights, so they can write and
  read anywhere you can, and use the network. A child started in the first milliseconds can escape
  the Job Object.
- **What the risk is:** allowlisted test commands run code the agent wrote. Keep the allowlist to
  commands you'd run yourself, and use harness-mcp only on personal projects.

### 5.5 Request bodies
- **Compressed bodies are refused** (415) on both servers before any parser runs. Express
  decompresses `gzip`/`deflate`/`br` bodies itself, and Node's Brotli decoder before 24.22.1 has an
  out-of-bounds write (CVE-2026-111497, "Node2Shell") reachable from the public OAuth and sign-in
  endpoints without signing in. Chat apps don't compress requests.
- **Node must be 24.22.1 or later** (or 22.23.4 / 26.12.1); the guard is defence in depth.

### 5.6 Control page and records
- **Control page:** loopback only. Host and Origin are checked (any loopback origin, any port),
  every action needs a per-start CSRF token, and stale tabs reload themselves. Every refusal states
  its reason.
- **Audit log:** `~/.harness-mcp/audit/YYYY-MM-DD.jsonl` records every tool call (arguments, redacted
  output, redaction counts) and every decision.
- **Retention:** audit logs, run logs, stored outputs and checkpoints older than 14 days are deleted
  at start, and at most 200 checkpoints are kept (`retention` in config). Run history is kept in
  `runs/index.json`.

## 6. Running it
`start.cmd` (double-click, or from cmd/PowerShell) starts the server and the quick tunnel. Ctrl+C
stops both. Setup is `npm run setup`: passphrase, authenticator, tunnel mode, first workspace.

## 7. Tests
`npm test` runs 67 automated tests:
- Authentication, including the sign-in endings and Back/Reload.
- Loopback surfaces, scope and redaction.
- Sandbox and approvals, in-call approvals and the fix loop.
- Per-request public address.
- Automatic access requests, run history, watch skip and retention.
- Encrypted secrets, including migration and tamper handling.
- The tight allowlist, recipe-only test commands, unsafe git options and `.git` protection.
- That the control page script parses.
- That compressed request bodies are refused on every endpoint (Node2Shell).
- Trusted and untrusted workspaces, the approval cards' change lists and diffs, and Mark as seen.

Group E (real chat apps through the tunnel) is manual and still to do (§8).

## 8. Status and open work (2026-10-30)

| Step | Item | State |
|---|---|---|
| 1 | Auto access requests · probe removed · `start.cmd` · run history · watch skip · retention · this doc | **Done** |
| 2 | Personal-data masking | Skipped by decision (no customer data) |
| 3 | Encrypt `secrets.json` with Windows DPAPI (this user + this PC, app-specific entropy); old plain files migrate at start; unreadable or tampered files fail closed | **Done** |
| 4 | Write-confining command sandbox | **Dropped by decision.** Commands run in **limits-only** mode. Evaluated: Codex sandbox (dependency on Codex), Docker (heavy memory), WSL + bubblewrap (lightest, confinement proven on this PC, then removed). Protection comes from the allowlist, in-call approvals, Job Object limits, a scrubbed environment and harness-mcp's own path checks on every edit (§5.4). |
| — | Node2Shell: refuse compressed bodies; Node 24.22.2 | **Done** |
| — | Approval cards with changes since your last approval; trusted/untrusted workspaces | **Done** |
| 5 | End-to-end check with ChatGPT and Claude (group E, the new sign-in flow, 85 s waits) | Planned |
| — | Let `python <file>.py` in the workspace run without approval | Not planned: without write confinement, it stays behind approval |
| — | Code mode (`exec` in an isolate) | Later |
| — | Tray app / Windows service | Later |

Stack: Node 24 + TypeScript (run directly), `@modelcontextprotocol/sdk`, zod, express, `koffi`
(Win32 FFI), `@vscode/ripgrep`, `cloudflared`. Ideas from the DeepSeek harness (MIT) and Codex.
