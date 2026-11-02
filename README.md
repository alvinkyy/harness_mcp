# harness-mcp

**Let web AI agents (claude.ai, ChatGPT and others) read, edit and test the code on your Windows PC, safely.**

You chat in your browser as usual. When the agent needs your code, it calls harness-mcp on your PC
through a secure tunnel. harness-mcp reads the files, applies the agent's fixes, runs your tests in a
sandbox, and sends the results back. The agent keeps fixing until the tests pass. Anything risky
waits for **your** click on a control page that only your PC can open.

```
  You, in the browser                        Your Windows PC
 ┌──────────────────────┐               ┌───────────────────────────────────┐
 │ claude.ai / ChatGPT  │  HTTPS+OAuth  │  cloudflared (tunnel)             │
 │ "make the tests pass"│ ────────────▶ │     │                             │
 └──────────────────────┘   Cloudflare  │     ▼                             │
                                        │  harness-mcp  127.0.0.1:8787      │
                                        │   read · patch · test (sandbox)   │
                                        │     │                             │
                                        │  Control page 127.0.0.1:8788  ◀── you approve here
                                        └───────────────────────────────────┘
```

---

## Contents

1. [What you get](#1-what-you-get)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Install](#3-install)
4. [Run the setup wizard](#4-run-the-setup-wizard)
5. [Fill in your settings (`config.json`)](#5-fill-in-your-settings-configjson)
6. [Start harness-mcp](#6-start-harness-mcp)
7. [Connect your chat app](#7-connect-your-chat-app)
8. [Everyday use](#8-everyday-use)
9. [The control page](#9-the-control-page)
10. [Security: what protects you](#10-security-what-protects-you)
11. [Troubleshooting](#11-troubleshooting)
12. [Commands reference](#12-commands-reference)
13. [Uninstall](#13-uninstall)
14. [For developers](#14-for-developers)

---

## 1. What you get

| Feature | What it means for you |
|---|---|
| **Works with any web agent** | claude.ai, ChatGPT and any other chat app that supports remote MCP connectors. |
| **Fix loop** | Ask once ("make the tests pass"). The agent patches, tests, reads failures and tries again by itself, until tests pass, the same failure repeats 3 times, or 6 attempts. |
| **You stay in control** | New connections, unknown commands, undo and folder access all wait for your click on the control page. |
| **Sandbox** | Commands can write only inside your project folders. Network tools are blocked. Each command has memory, CPU and time limits. |
| **Undo** | A checkpoint is saved before every change. Revert any of them from the control page. |
| **Secret masking** | API keys, tokens, passwords and card numbers are masked before anything leaves your PC. |
| **Audit log** | Every tool call and every decision is recorded on your PC. |

---

## 2. What you need before you start

| Item | Why | How to get it |
|---|---|---|
| **Windows 10 or 11** | The sandbox uses Windows security features. | — |
| **Node.js 24.22.1 or newer** | Runs harness-mcp. Older versions have a security bug. | [nodejs.org](https://nodejs.org) (LTS), or `winget install OpenJS.NodeJS.LTS` |
| **cloudflared** | Makes your PC reachable from the chat app, without opening ports. | `winget install --id Cloudflare.cloudflared` |
| **An authenticator app** | Second sign-in factor (6-digit code). | Google Authenticator, Microsoft Authenticator, 1Password, … |
| **A chat app that supports custom connectors** | Where you talk to the agent. | claude.ai (Settings → Connectors) or ChatGPT (custom MCP server). Check your plan: some ChatGPT plans allow read-only tools only. |
| **Your project's tools** | So tests can run. | e.g. Python, PHP/Composer, Go, Git — whatever your project uses. |

Check Node's version:

```bash
node --version
```

---

## 3. Install

```bash
git clone <this-repository-url> harness-mcp
```

```bash
cd harness-mcp/bridge
```

```bash
npm install
```

> **PowerShell users:** if `npm` is blocked by the script policy, use `npm.cmd` instead
> (e.g. `npm.cmd install`), or run the commands from **cmd**.

---

## 4. Run the setup wizard

From the `bridge` folder:

```bash
npm run setup
```

The wizard asks four things. Here is what to enter:

| The wizard asks | What to type | Example |
|---|---|---|
| **Choose a passphrase (12+ characters)** | A long passphrase you will type each time a chat app connects. It is hidden as you type. Enter it twice. | `correct horse battery staple` (pick your own) |
| **Let harness-mcp start a Cloudflare quick tunnel for you?** | `y` — easiest. harness-mcp starts the tunnel each time. (`n` only if you run your own tunnel.) | `y` |
| **Fixed public URL** | Leave **blank** unless you own a domain with a named Cloudflare tunnel (see [5.3](#53-optional-fixed-address-on-your-own-domain)). | *(blank)* |
| **A project folder the agents may work in** | The full path of the project you want the agent to edit and test. | `C:\Users\<you>\Projects\my-app` |

Then the wizard prints an **authenticator secret**:

1. Open your authenticator app → **Add account** → **Enter a setup key**.
2. Account name: `harness-mcp`. Key: the secret shown. Type: time-based.
3. The app now shows a 6-digit code that changes every 30 seconds. You'll need it when connecting.

> ⚠️ **Keep the passphrase and the authenticator secret on your PC only.** Never paste them into
> any chat, ticket or document. They are stored encrypted (Windows DPAPI), readable only by your
> Windows account on this PC.

Everything harness-mcp stores lives in `%USERPROFILE%\.harness-mcp\` (settings, encrypted secrets,
logs, checkpoints).

---

## 5. Fill in your settings (`config.json`)

The wizard creates `%USERPROFILE%\.harness-mcp\config.json` with safe defaults. Open it in any text
editor to change what agents may touch. **Restart harness-mcp after editing.**

> In JSON, Windows paths need **double backslashes**: `C:\\Users\\you\\Projects\\my-app`.

### 5.1 The settings most people change

| Setting | What it controls | Default |
|---|---|---|
| `workspaces` | Folders the agent may **edit and run commands in**. Your project folders. | the folder you gave the wizard |
| `readRoots` | Folders the agent may **read** (but not change). | `Desktop\Project` |
| `recipes` | The **test command(s)** for each workspace. If you skip this, it's detected (see below). | detected |
| `commandAllowlist` | Extra commands that run **without asking you**. Keep this short. | read-only `git` commands |
| `extraDeny` | Extra files/folders that are **never shared** (adds to the built-in list). | none |
| `sandbox.mode` | `"workspace-write"` (sandbox on) or `"off"`. | `"workspace-write"` |

### 5.2 Example `config.json`

```json
{
  "publicUrl": "auto",
  "tunnel": { "mode": "quick", "cloudflared": "", "protocol": "http2" },

  "readRoots": ["C:\\Users\\you\\Projects"],
  "workspaces": ["C:\\Users\\you\\Projects\\my-app"],

  "recipes": {
    "C:\\Users\\you\\Projects\\my-app": {
      "commands": ["python -m unittest -v"],
      "watch": true
    }
  },

  "commandAllowlist": ["git status", "git status *", "git log *", "git diff *", "git show *", "git branch", "git branch --list *"],
  "extraDeny": ["**/customer-exports/**"],
  "sandbox": { "mode": "workspace-write" }
}
```

You only need the keys you want to change; anything missing uses the default.

**Test recipes.** `commands` run in order and stop at the first failure. `"watch": true` reruns the
tests whenever *you* save a file, so the agent always sees fresh results. Without a recipe,
harness-mcp detects one:

| If the workspace has… | It runs |
|---|---|
| `package.json` | `npm test` |
| `composer.json` | `vendor\bin\phpunit` (or `composer test`) |
| `pytest.ini` or `conftest.py` | `python -m pytest -q` |
| `test_*.py` / `*_test.py` files, or a `tests` folder | `python -m unittest -v` |
| `pyproject.toml` | `python -m pytest -q` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |

### 5.3 Optional: fixed address on your own domain

The quick tunnel's address (`https://<random-words>.trycloudflare.com`) **changes every time you
start harness-mcp**, so you must update the connector URL in your chat app after each restart. If you
own a domain on Cloudflare, a *named tunnel* keeps the address fixed:

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create harness-mcp
```

```bash
cloudflared tunnel route dns harness-mcp mcp.example.com
```

Create `%USERPROFILE%\.cloudflared\config.yml` (use the tunnel id printed by `tunnel create`). Route
**only port 8787** — never 8788, the control page:

```yaml
tunnel: <tunnel-id>
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

In `config.json` set `"publicUrl": "https://mcp.example.com"` and `"tunnel": { "mode": "none" }`,
then run the tunnel yourself:

```bash
cloudflared tunnel run harness-mcp
```

Don't put Cloudflare Access in front of this hostname — chat apps can't log in through it.

### 5.4 Advanced settings

| Setting | Meaning | Default |
|---|---|---|
| `limits.commandTimeoutSec` | A command is killed after this many seconds. | `600` |
| `limits.commandMemoryMb` | Memory cap per command. | `4096` |
| `limits.toolWaitSec` | How long a tool call waits for a result or your approval. **Keep under 100** (Cloudflare's limit). | `85` |
| `auth.idleDisconnectHours` | Agents idle longer than this must sign in again. | `2` |
| `auth.consentTimeoutSec` | Time you have to approve a new connection. | `120` |
| `auth.maxFailedLogins` / `auth.lockoutMinutes` | Sign-in lockout. | `5` / `15` |
| `retention.days` / `retention.maxCheckpoints` | How long logs and checkpoints are kept. | `14` / `200` |
| `mcpPort` / `controlPort` | Local ports. | `8787` / `8788` |

---

## 6. Start harness-mcp

Double-click **`bridge\start.cmd`**, or run it from a terminal in the `bridge` folder:

```bash
.\start.cmd
```

Then open the control page **on this PC**: **http://127.0.0.1:8788**

- Keep the window and the control page open while you work. Stop with **Ctrl+C**.
- The control page shows a green **"Sandbox on"** banner when the sandbox is working.
- The **Connect** tab shows your connector address (`https://….trycloudflare.com/mcp`) with a Copy button.

> **Keep the PC awake.** If the laptop sleeps, harness-mcp and the tunnel pause, and the chat app
> can't reach it. A locked screen is fine. To stay awake when plugged in: Settings → System → Power →
> sleep **Never** (and lid close → **Do nothing**).

---

## 7. Connect your chat app

Copy the address from the control page's **Connect** tab. It ends in `/mcp`.

**claude.ai:** Settings → Connectors → **Add custom connector** → paste the address.

**ChatGPT:** chatgpt.com → Apps & Connectors (or `chatgpt.com/plugins`) → **+** / **Add custom MCP
server** → URL: the address, Authentication: **OAuth**.

**Other web agents:** add a remote / custom MCP server with that address and OAuth.

Then:

1. A sign-in page opens. Enter your **passphrase** and the **6-digit code** from your authenticator.
2. On the **control page** a card appears for the new agent. Choose:
   - **read-only** — the agent can read and search files, see runs. Nothing changes on your PC.
   - **full** — it can also edit files, run tests and commands, and ask for folder access.
3. Click **Allow connection** within 2 minutes. The browser returns to the chat, connected.

> **Changed an agent from read-only to full later?** The chat app remembers the old tool list.
> Refresh the connector in the chat app's settings and start a **new chat**, or disconnect and
> reconnect it.

---

## 8. Everyday use

Just ask in the chat. Examples:

- *"Look at my project and explain how it's structured."*
- *"The tests in my-app fail. Make them pass."*
- *"Add input validation to calculator.py and write tests for it."*
- *"Show me the diff of what you changed."*

**What happens on your PC:**

1. The agent reads files (`workspace_info`, `read_files`, `search`).
2. It sends a patch (`apply_patch`). A checkpoint is saved, then the patch is applied.
3. Your test recipe runs in the sandbox. The failures go back to the agent.
4. The agent fixes and repeats until done, then summarises.

**When you need to click something** (the control page beeps and shows a desktop notification once
you click **Turn on alerts**):

| You'll see | Why | Your choice |
|---|---|---|
| **New connection** | A chat app wants to connect. | Allow (read-only or full) / Refuse |
| **Command** | The agent wants to run something not on the allowlist. The card shows the command and any files the agent changed since your last approval, with a diff. | Approve / Deny |
| **Outside sandbox** (red) | The agent asks to run a command with full rights, e.g. `npm install` (needs the network). It must give a reason. | Approve only if you'd run it yourself |
| **Folder access** | The agent needs a folder outside its allowed ones. You can narrow it (subfolder, read instead of write, set hours). After you refuse, the agent can't ask about that folder again for 10 minutes. | Allow / Refuse |
| **Revert** | The agent wants to undo to a checkpoint. | Approve / Deny |

The agent's tool call **waits up to 85 seconds** for your click, so the conversation continues
without you typing anything. If you're slower, the agent checks back later.

**If your plan only allows read-only tools:** the agent can still propose a patch. Paste it in the
control page's **Paste a patch** box and click **Apply and run tests**; the agent reads the result.

**Limits to know:**
- The agent works with **text files**. It can't save images or other binary files you upload to the chat.
- Changes you approve stay on your PC; nothing is committed or pushed for you.

---

## 9. The control page

Open **http://127.0.0.1:8788** on this PC only (it is never exposed to the internet).

| Tab | What's there |
|---|---|
| **Inbox** | Everything waiting for you: connections, commands, folder access, reverts. |
| **Agents** | Connected chat apps. Change read-only ↔ full, **Disconnect** one, or **Disconnect all agents**. |
| **Runs** | Recent test runs and commands, with status, sandbox badge and output. |
| **Folders** | Allowed folders and folders shared on request. Mark a workspace **trusted** / **untrusted**, **Mark as seen**, switch a shared folder between **Read only** and **Read and write**, **Stop sharing**, and **Allow asking again** for folders you refused. |
| **Connect** | Your connector address with Copy, and **New tunnel** to get a fresh address. |
| **Activity** | Recent actions and decisions. |
| **Paste a patch** | Apply a patch yourself and run tests. |

**Trusted vs untrusted workspaces:**
- **Trusted** (folders in `workspaces`): tests run on the agent's changes without asking.
- **Untrusted** (folders shared on request): tests wait for your approval while there are agent
  changes you haven't seen. Approving a card, or **Mark as seen**, counts them as seen.

---

## 10. Security: what protects you

| Layer | Protection |
|---|---|
| **Sign-in** | Passphrase + authenticator code. 5 wrong tries → locked 15 minutes. |
| **Local approval** | Every new connection must be allowed on the control page, which only this PC can open. New agents start read-only. |
| **Tokens** | Expire after 15 minutes and rotate. Agents idle for 2 hours must sign in again. Disconnect any agent at any time. |
| **Folder scope** | Agents read only `readRoots` + workspaces, and write only in `workspaces`. Anything else needs your approval. |
| **Never shared** | `.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.npmrc`, `.env*`, keys/certificates, `configuration.php`, `wp-config.php`, credential files, browser profiles, Windows credential stores, Outlook data, `C:\Windows`, other users' folders. This list can only grow (`extraDeny`). |
| **Secret masking** | Private keys, API/cloud tokens, JWTs, bearer tokens, passwords in connection strings and config, and card numbers (last 4 kept) are masked in everything sent out. Masked text can't be written back. |
| **Commands** | Only read-only `git` and each workspace's own test command run without asking. Commands with `& | ; < > ^ %VAR%` always ask. The agent can't edit `.git`. |
| **Sandbox** | Commands run at Windows **Low integrity** with no privileges: they can write only in your workspaces (`.git` stays read-only), inside a Job Object (memory, CPU, time caps; whole process tree killed on timeout). Network tools (npm/pip installs, git fetch/push, ssh) are blocked. |
| **Audit** | `%USERPROFILE%\.harness-mcp\audit\YYYY-MM-DD.jsonl` records every call and decision. |

**Honest limits:**
- Sandboxed commands can still **read** anything your Windows account can read.
- The network block is **advisory**: a program that opens network connections by itself can still get out.
- **Whoever controls your chat account is "you"** to harness-mcp. Turn on two-factor sign-in for your chat accounts.
- Use it on your own projects. Don't point it at folders containing customer data or production credentials.

---

## 11. Troubleshooting

| Problem | Cause and fix |
|---|---|
| **The chat says it has no local access / can't reach the connector** | harness-mcp isn't running, the PC is asleep, or the tunnel address changed. Start `start.cmd`, check the control page's **Connect** tab, and update the connector URL in the chat app if it changed. |
| **"Internal error" when the agent asks for write access, or it says it has no such tool** | The agent is **read-only**. Switch it to **full** on the **Agents** tab, then refresh the connector in the chat app and start a new chat. |
| **The agent's command shows `awaiting-approval`** | It's waiting for you. Approve it in the **Inbox** (or on the run card). |
| **Sign-in page says locked** | Too many wrong codes. Wait 15 minutes. Check your PC's clock is correct (authenticator codes depend on it). |
| **Connection approval timed out** | You have 2 minutes to click **Allow connection**. Connect again. |
| **Red "Limits-only" banner** | The sandbox self-test failed; the banner says why. Commands still run with limits, but with your full rights. |
| **A test needs to install packages and fails offline** | Installs need the network, which the sandbox blocks. Install them yourself, or let the agent request an **outside-sandbox** run and approve it. |
| **Git-Bash tools (`ssh`, its `whoami`) fail inside the sandbox** | Known limitation. Use the Windows versions or run outside the sandbox. |
| **`npm` is blocked in PowerShell** | Use `npm.cmd …`, `start.cmd`, or a cmd window. |
| **Port 8787/8788 already in use** | Another copy (or another program) is running. Close it, or change `mcpPort` / `controlPort`. |
| **cloudflared not found** | Install it (`winget install --id Cloudflare.cloudflared`) or set its path in `tunnel.cloudflared`. |
| **The agent needs to write to a folder you shared read-only** | On the **Folders** tab, switch that folder to **Read and write**. No new request needed. Or let the agent try the write: it asks for write access automatically. |
| **You refused a folder by mistake** | On the **Folders** tab, under **Refused folders**, click **Allow asking again**, then ask the agent to retry. Otherwise it can ask again after 10 minutes. |
| **A command was refused after a restart** | Pending approvals don't survive a restart. Ask the agent to try again. |

---

## 12. Commands reference

Run these in the `bridge` folder.

| Command | What it does |
|---|---|
| `npm run setup` | Create or replace the passphrase and authenticator secret; set the tunnel and first workspace. |
| `start.cmd` (or `npm start`) | Start harness-mcp and the tunnel. |
| `npm run status` | Show settings and connected agents. |
| `npm run sandbox:remove` | Remove the folder labels the sandbox added (stop harness-mcp first). |
| `npm test` | Run the automated test suite. |
| `npm run typecheck` | Type-check the TypeScript. |

### Tools the agent gets

| Read-only profile | Full profile adds |
|---|---|
| `workspace_info` — overview of a project | `apply_patch` — edit files (checkpoint first; can run tests) |
| `list_roots` — allowed folders | `write_file` — create or replace a text file |
| `find_files` — find files by name | `run_tests` — run the workspace's test recipe |
| `read_files` — read files | `run` — run a command (asks unless allowlisted) |
| `search` — search file contents | `kill_run` — stop a running command |
| `git_diff` — see changes | `revert_checkpoint` — undo (asks you) |
| `list_runs` / `get_run` — run history and results | `request_access` — ask for another folder (asks you) |
| `read_output` — long output, page by page | `set_workspace` — switch project |
| `list_checkpoints` — saved restore points | |
| `get_access_request` — status of a request | |

---

## 13. Uninstall

1. Stop harness-mcp (**Ctrl+C**).
2. In `config.json` set `"sandbox": { "mode": "off" }`, then remove the sandbox's folder labels:
   ```bash
   npm run sandbox:remove
   ```
3. Remove the connector from each chat app.
4. Delete `%USERPROFILE%\.harness-mcp\`, `%LOCALAPPDATA%\harness-mcp-sandbox\` and this folder.
5. Remove the `harness-mcp` entry from your authenticator app.

---

## 14. For developers

**Stack:** Node 24 (runs TypeScript directly), `@modelcontextprotocol/sdk`, zod, express, koffi
(Windows API calls), `@vscode/ripgrep`, cloudflared.

```
harness_mcp/
├── README.md                    ← this file
├── DESIGN.md                    ← design, threat model and status
└── bridge/
    ├── start.cmd                ← start script
    ├── src/
    │   ├── main.ts / app.ts     ← start-up, MCP server
    │   ├── auth.ts              ← OAuth 2.1, sign-in, tokens
    │   ├── tools.ts             ← the agent's tools
    │   ├── runner.ts            ← runs, test recipes, watch mode
    │   ├── patch.ts / edits.ts  ← patch format, read-before-write
    │   ├── checkpoints.ts       ← undo
    │   ├── scope.ts             ← allowed folders, deny list
    │   ├── redact.ts            ← secret masking
    │   ├── sandbox*.ts          ← Low-integrity sandbox, Job Objects
    │   ├── control.ts + control-page.html ← local control page
    │   ├── tunnel.ts            ← Cloudflare quick tunnel
    │   └── secrets.ts / dpapi.ts← encrypted secrets
    └── test/                    ← automated tests (npm test)
```

- Design decisions and the threat model: [DESIGN.md](DESIGN.md).
- Tests: `npm test` covers sign-in, scope, masking, commands, approvals, the fix loop, the sandbox
  and request handling. Testing through real chat apps is manual (see DESIGN.md §7).

**Credits.** Ideas from the [DeepSeek harness](https://github.com/deepseek-ai/deepseek-harness) (MIT)
and OpenAI's Codex. The sandbox follows Codex's published Windows sandbox model; no Codex code is
included.
