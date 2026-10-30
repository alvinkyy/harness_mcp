# OpenAI Codex desktop app (Windows) — how the harness works

Target: `C:\Program Files\WindowsApps\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`
(MSIX `OpenAI.Codex` 26.1021.3705.0, display name "ChatGPT"; bundled `codex-cli 0.164.0-alpha.11.1`).

Method: static inspection of the shipped package (AppxManifest, ASAR header + extracted main-process
bundles, plugin manifests), REA evidence for the ASAR and binaries, `--help` output of the bundled
binaries, and `codex debug prompt-input` (renders the model-visible prompt locally; no model call).
No app UI was run or instrumented, so everything about runtime order is inferred from code/strings.

## 1. Process architecture

```
ChatGPT.exe  (4.5 MB launcher, "Owl" runtime = OpenAI's Chromium/Electron fork; chrome.dll 318 MB)
  └─ app.asar  (Vite-built Electron app "openai-codex-electron" 26.1021.31345)
       main:    .vite/build/early-bootstrap.js → bootstrap / main-*.js (5 MB) / worker.js
       preload: preload.js, browser-page-preload.js, sandbox-preload.js
       UI:      webview/index.html + ~20k hashed assets (React SPA)
       │
       │  JSON-RPC over stdio  (Windows)      ┌ ws://localhost/rpc over unix socket
       │                                      └ (non-Windows, opt-in local daemon)
       ▼
  resources/codex.exe  app-server --analytics-default-enabled  -c features.code_mode_host=true ...
       (the Rust Codex core: agent loop, model client, tools, config, thread store)
       ├─ codex-code-mode-host.exe   V8 isolate host for the `exec` JS tool (stdio / gRPC)
       ├─ codex-command-runner.exe   shell command runner (pipe-based)
       ├─ codex-windows-sandbox-service.exe  LocalSystem service "CodexSandboxService"
       ├─ codex-windows-sandbox-setup.exe
       ├─ rg.exe                     ripgrep for search
       ├─ MCP servers (config + bundled plugins, launched via cua_node/bin/node.exe)
       └─ tectonic.exe               LaTeX plugin
```

Evidence:
- `application-network-startup-*.js` `connect()` picks `kind="stdio"` unless (non-Windows &&
  `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` && daemon reachable at
  `<CODEX_HOME>/app-server-control/app-server-control.sock`), then uses websocket.
- Env passed to the child: `LOG_FORMAT=json`, `RUST_LOG=warn`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`,
  `CODEX_MCP_NODE_PATH` (bundled node), optional `-c features.windows_sandbox_service=true`.
- WSL mode: the app can instead run `codex -c features.code_mode_host=true app-server
  --analytics-default-enabled` inside a WSL distro (`bootstrap-*.js`).
- `codex app-server --help`: `--listen stdio:// | unix:// | ws://IP:PORT | off`, `daemon`, `proxy`,
  `generate-ts`, `generate-json-schema` (the protocol is schema-generated; package.json runs
  `../app-server-types/generate-types.mjs` before builds).
- Manifest: firewall holes for ports 1455/1457 (OAuth login callback) and 3128–3159 / 8081–8112
  (proxy ranges) on `codex.exe`; Chrome native-messaging host alias; `codex://` protocol;
  Explorer "Open project in Codex" COM verb; startup task.
- Electron fuses: no fuse sentinel found in `ChatGPT.exe` (REA `ev_e07749c3…`), consistent with a
  custom Owl launcher rather than stock Electron — fuse state unknown, not "disabled".
- ASAR integrity metadata mismatches 8 unpacked native modules (node-pty, better-sqlite3, HID,
  serialport) — normal post-packaging signing, recorded as untrusted bytes (REA `ev_11cca5d7…`).

## 2. UI ↔ core protocol (app-server JSON-RPC)

Method/notification names recovered from the main bundle (selection):

| Area | Methods |
|---|---|
| Threads | `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/search`, `thread/rollback`, `thread/revert`, `thread/compact/start`, `thread/archive`, `thread/delete`, `thread/goal/*`, `thread/queue/*`, `thread/realtime/*` (voice) |
| Turns | `turn/start`, `turn/steer`, `turn/interrupt`, `turn/addUserMessage`; notifications `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated` |
| Items (streamed) | `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `item/plan/delta` |
| Approvals (server→client requests) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/autoApprovalReview/*` |
| Host services | `fs/*` (read/write/watch), `command/exec*`, `config/read`, `config/value/write`, `config/mcpServer/reload`, `model/list`, `skills/list`, `plugin/*`, `account/*`, `feedback/upload` |

So the desktop UI is a thin client: the Rust core owns the conversation ("thread"), turns, items,
and asks the UI for approvals via server-initiated requests.

## 3. The agent loop as the model sees it ("code mode")

`codex debug prompt-input "hello"` rendered the request input list:

1. `additional_tools` with three namespaces:
   - `functions`: **`exec`** (custom tool, Lark grammar = raw JS source with optional
     `// @exec: {...}` pragma), `wait`, `request_user_input`, `request_user_input_async`
   - `clock`: `sleep`
   - `collaboration`: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
     `interrupt_agent`, `list_agents` (multi-agent tree rooted at `/root`; message args are
     marked `encrypted: true`)
2. developer message: base instructions (~18k chars; sections Personality, Writing style,
   permissions, autonomy, commentary/final answer formatting, skills, plugins & apps).
3. developer message: `<skills_instructions>` (skill roots `~/.codex/skills`, `~/.agents/skills`, …),
   `<collaboration_mode>`, `<recommended_plugins>`.
4. developer messages: `<multi_agent_role>` and `<multi_agent_mode>`.
5. user message: `<environment_context>` — cwd, shell (powershell), date, timezone, and a
   `<permission_profile>` describing filesystem access (here: managed, read-only at root).
6. the user prompt.

Key design point — **code mode**: the model has essentially one action tool, `exec`, which runs
JavaScript in a fresh V8 isolate (in `codex-code-mode-host.exe`) with *no* Node/fs/network. Real
capabilities are exposed as async functions on a global `tools` object:
`tools.exec_command`, `tools.write_stdin`, `tools.apply_patch`, `tools.view_image`,
`tools.list_mcp_resources`, `tools.read_mcp_resource`, `tools.request_plugin_install`,
`tools.clock__curr_time`, and every MCP tool as `tools.mcp__<server>__<tool>`. Long scripts yield a
`cell_id`; the model resumes with `wait`. This lets one model step compose many tool calls.

## 4. Safety / sandboxing

- Policies: `--sandbox read-only | workspace-write | danger-full-access`;
  `--ask-for-approval on-request | never`; `--approve-for-me` (automatic review — the
  `guardian_approval` feature, surfaced as `item/autoApprovalReview/*`).
- Windows: `codex sandbox` runs commands "under Windows restricted token sandbox"; the MSIX installs
  `CodexSandboxService.OpenAI.Codex` as an auto-start LocalSystem service (feature
  `windows_sandbox_service`, under development) plus `codex-windows-sandbox-setup.exe`.
- Named permission profiles (`-P`), per-thread writable roots (`project-writable-roots`), network
  proxy feature, hook trust (`--dangerously-bypass-hook-trust`).
- MCP per-tool approval modes in plugin manifests (e.g. `codex_app` tools default `approve`,
  thread-mutating ones `prompt`).

## 5. Extensibility

- **Plugins** (`.codex-plugin/plugin.json`): may declare `mcpServers` (`.mcp.json`), `skills/`,
  `hooks`. Bundled marketplace `openai-bundled`: browser, chrome, codex-app-tools, computer-use,
  unified-computer-use, deep-research, image-guided-assets, latex, visualize.
- **Hooks**: e.g. the browser plugin wires `Stop`, `SubagentStop`, `Interrupt` events to an MCP tool
  call (`node_repl.turn_ended`).
- **MCP**: `codex mcp add/list/login` (OAuth), elicitation, resources; per-server
  `enabled_tools`, `omit_tools_from: ["code_mode","deferred"]`, output token limits.
- **Skills**: `SKILL.md` folders discovered from skill roots and listed in the prompt.
- **Feature flags**: ~150 flags (`codex features list`) — stable-on includes `code_mode_host`,
  `multi_agent`, `unified_exec`, `shell_snapshot`, `guardian_approval`, `hooks`, `plugins`,
  `goals`, `computer_use`, `browser_use`, `image_generation`, `skill_search`.

## 6. State

- Config: `~/.codex/config.toml` + profiles (`$CODEX_HOME/<name>.config.toml`), `-c key=value`
  overrides, managed requirements (`--print-startup-config`).
- Threads/rollouts stored locally (CLI has `migrate-rollouts` to "paginated thread history",
  `resume`, `fork`, `archive`, `delete`); app-side SQLite via better-sqlite3.

## Unknowns
- Exact sandbox enforcement mechanism of the service (not disassembled; `codex.exe` 354 MB exceeds
  REA's Rust-metadata size guard and was not opened in a disassembler).
- Model wire protocol details (Responses API usage inferred from `--search` help text only).
- Renderer/IPC graph of the 20k-file webview was not analyzed.
