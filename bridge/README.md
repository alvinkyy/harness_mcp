# harness-mcp

A local MCP server that lets web agents (claude.ai, ChatGPT and any other web agent with remote
MCP connectors) read your code, build on it, and run your tests on this PC. You keep control from
a control page that only this PC can open. Design and threat model: [../DESIGN.md](../DESIGN.md).

```
web agent ──HTTPS + OAuth──▶ Cloudflare ──▶ cloudflared (this PC) ──▶ 127.0.0.1:8787/mcp
                                                    you ──▶ 127.0.0.1:8788 (control page, never exposed)
```

## 1. Install and set up (once)

Requires Node 24.22.1+ on Windows. Older versions have the Node2Shell Brotli bug
(CVE-2026-111497). harness-mcp refuses compressed request bodies as well, but upgrade Node anyway.

```bash
npm install
```

```bash
npm run setup
```

Setup asks for:
- **A passphrase** (12+ characters).
- **Whether harness-mcp should start a Cloudflare quick tunnel** for you (step 3, option A).
- **A fixed public URL**, only if you have a named tunnel on your own domain (option B). Leave it
  blank otherwise.
- **A project folder** the agents may work in.

It also prints an authenticator secret. Add it to an authenticator app such as Google or Microsoft
Authenticator, and keep it on this PC. Secrets are stored encrypted with Windows DPAPI, readable only
by your Windows account on this PC.

Everything is stored in `%USERPROFILE%\.harness-mcp\`. To change scope later, edit `config.json`
there:

| Key | Meaning |
|---|---|
| `readRoots` | Folders agents may read |
| `workspaces` | Folders agents may write to and run commands in |
| `recipes` | Test commands per workspace, e.g. `{"C:\\code\\shop": {"commands": ["php -l index.php", "vendor\\bin\\phpunit"], "watch": true}}`. Without one, the recipe is detected from `package.json` / `composer.json` / etc. |
| `commandAllowlist` | Extra commands that run without asking. The default is read-only git only; each workspace's own test command (from `recipes`) is always allowed. Avoid wildcards that run project scripts (e.g. `npm run *`): the agent can edit those scripts. Commands with `& | ; < > ^ %VAR%`, or git options like `--output`/`-c`, never auto-run. |
| `extraDeny` | Extra file patterns to never share (the built-in list can't be reduced) |

## 2. Run

Double-click `start.cmd`, or run it from cmd or PowerShell:

```bash
.\start.cmd
```

(`npm start` also works in cmd. In PowerShell, plain `npm` is blocked by the script policy, so use
`start.cmd` or `npm.cmd start`.)

Then open http://127.0.0.1:8788 on this PC and keep it open while you work. Several things wait for
you there:
- new connections;
- non-allowlisted commands and reverts;
- folder access.

When an agent touches a file outside the folders it may use, it asks for access to that folder
automatically and waits for your answer.

## 3. Make it reachable from the internet

### Option A: quick tunnel, managed by harness-mcp (no domain needed)

In `config.json`:

```json
"publicUrl": "auto",
"tunnel": { "mode": "quick", "cloudflared": "", "protocol": "http2" }
```

`start.cmd` then starts `cloudflared` itself. Don't run your own copy as well.

- **Where the address is:** shown on the control page (top strip and **Connect**), with a Copy
  button. It looks like `https://<random-words>.trycloudflare.com/mcp`.
- **It changes on every start.** When it does, the page shows the old and new address, and you must
  update the connector in each chat app. **New tunnel** on the Connect page gets a fresh one.
- **No secret goes in the address.** Agents sign in with your passphrase + authenticator code, and
  you allow them in the Inbox.
- **If you run cloudflared yourself** (`"tunnel": {"mode": "none"}`) with `publicUrl` set to
  `"auto"`, harness-mcp learns the address from the first request that arrives through it.
  Hostnames must match `publicHosts` (default `*.trycloudflare.com`); anything else gets 421.

### Option B: named tunnel on your own domain (address never changes)

You need a domain on your Cloudflare account. `cloudflared` is already installed on this PC. Set
`"publicUrl": "https://mcp.example.com"` and `"tunnel": {"mode": "none"}`.

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create harness-mcp
```

```bash
cloudflared tunnel route dns harness-mcp mcp.example.com
```

Create `%USERPROFILE%\.cloudflared\config.yml`. Use the tunnel id printed by `tunnel create`, and
route **only** the MCP port, never 8788:

```yaml
tunnel: <tunnel-id>
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel run harness-mcp
```

Do not put Cloudflare Access in front of this hostname. The claude.ai and ChatGPT servers can't
complete an Access login. Protection comes from OAuth plus your local approval.

## 4. Connect a web agent

Copy the address from the control page (**Connect**). With a named tunnel it is
`https://mcp.example.com/mcp`.

- **claude.ai:** Settings → Connectors → *Add custom connector* → paste the URL.
- **ChatGPT:** chatgpt.com/plugins → **+** → *Add custom MCP server* → Connection: the URL,
  Authentication: OAuth. Full write access depends on your ChatGPT plan; see DESIGN.md §1.
- **Any other web agent with remote MCP support:** add a remote/custom MCP server with that URL
  and OAuth.

When you connect:
1. A browser page asks for your passphrase and authenticator code.
2. The control page on this PC shows the request. Choose **read-only** or **full** and click
   **Approve** within 2 minutes.
3. The browser returns to the agent, connected.

A new agent starts read-only unless you pick full. You can change a client's profile or revoke it
on the control page at any time.

## 5. Tools the agent gets

| Read-only profile | Full profile adds |
|---|---|
| `workspace_info` | `apply_patch` (Codex patch format; checkpoint first) |
| `list_roots` | `write_file` |
| `find_files` | `run_tests` |
| `read_files` | `run` (allowlisted runs at once; anything else waits for you) |
| `search` | `kill_run` |
| `git_diff` | `revert_checkpoint` (waits for you) |
| `list_runs` / `get_run` | `request_access` (waits for you) |
| `read_output` | `set_workspace` |
| `list_checkpoints` | |
| `get_access_request` | |

### The fix loop (no back-and-forth)

Ask once, e.g. "make the tests pass". The agent is instructed to keep going on its own: patch and
test (`apply_patch` with `runTests: true`), read the failures, fix, and test again. It stops when the
tests pass, when the same failure repeats 3 times, or after 6 attempts.

- **Approvals don't end the agent's turn.** When a command needs approval, the tool call stays open
  for up to `limits.toolWaitSec` (85 s). Approve on the control page, or directly on the run card
  under Recent runs, and the agent receives the result in that same call.
- **Alerts.** Click **Enable alerts** once on the control page to get a beep and a desktop
  notification whenever something waits. The tab title shows the count.
- **Watch mode.** Recipes with `"watch": true` rerun the tests on every file change, so
  `get_run latest` is always current.
- **Cloudflare limit.** Keep `toolWaitSec` under 100: Cloudflare ends requests whose response takes
  longer than 100 s. Runs longer than that continue in the background, and the agent picks them up
  with `get_run`.

### Trusted and untrusted workspaces

Your test command runs code the agent wrote. Each folder agents can edit is either:
- **Trusted** (default for folders in `workspaces`): tests run on agent changes without asking.
- **Untrusted** (default for folders shared on request): tests wait for you whenever agents have
  changed files you haven't approved yet.

Switch either way on the control page (**Folders**). Every command card shows the files agents changed
since your last approval in that workspace, with a diff. Approving the card counts them as seen, and
so does **Mark as seen** on the Folders page. Patches you paste yourself never count as unseen.

For agents that can't write, such as plans limited to read-only tools: paste the agent's patch into
the control page and click **Apply & run tests**. The agent then reads the result with
`get_run latest`.

## 6. Tests

```bash
npm test
```

67 automated tests cover sign-in, scope, redaction, commands, approvals, trust and approval cards,
the fix loop, secrets and request-body handling (DESIGN.md §7). Group E
(through a real tunnel) is manual:

- **E1:** connect from claude.ai, ChatGPT and one other agent. Each needs the local Approve and
  then appears under *Connected agents*.
- **E2:** leave a connection idle past `auth.idleDisconnectHours`. It must reconnect.
- **E3:** click **Revoke** on a client. Its next call fails.
- **E4:** a never-seen agent shows as *NEW CLIENT* and starts read-only.

## Known limits

- **Limits-only mode, by decision.** Commands run in a Windows Job Object (process-tree kill,
  memory and CPU-time caps, scrubbed environment), but they are **not** confined to the workspace:
  they run with your full user rights and can use the network. A write-confining sandbox was
  evaluated and dropped (DESIGN.md §8). The guards are the tight allowlist, your approvals,
  untrusted workspaces, and harness-mcp's own path checks on every edit. Use it on personal
  projects only.
- **A brief Job Object gap.** A process the command spawns in its first few milliseconds, before
  the Job Object is assigned, could escape the job. A `taskkill /T` on timeout is the backstop.
- **Pending approvals don't survive a restart.** Run history does (`.harness-mcp\runs\index.json`),
  but a command still waiting for approval is refused when the server stops.
- **Connections that use plain `http://localhost` redirect URIs** are accepted only for local
  testing tools like MCP Inspector.
