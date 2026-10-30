# DeepSeek Harness (`dsh`): how it works, and how it compares with Codex

Source: https://github.com/deepseek-ai/deepseek-harness at commit `22ddee37` (2026-10-23), read
from git objects (the Windows checkout hit long-path failures). Labels: **[code]** = verified in
source, **[docs]** = README/docs only.

## 1. Shape

- TypeScript ESM on Node ≥24.9, pnpm monorepo, a single binary `dsh` (`apps/cli/src/bin.ts`). [code]
- Everything is a **Cordis plugin** (vendored `vendor/cordis`). Services hang off `ctx.*`
  (`ctx.llm`, `ctx.tools`, `ctx.sandbox`, `ctx.fs`, …), and behavior is extended through typed events
  dispatched as waterfall, serial, parallel or emit. [code]
- **Profiles** are stacks of YAML bundles: `dsh-base` (`packages/bundle/base/cordis.patch.yml`),
  then a mode bundle (`web-app`, `headless`, `sdk-app`, `acp-app`), then the profile patch, the home
  patch and `--patch` overlays. A patch replaces one plugin row's config. [code/docs]

```
dsh --profile web|headless|sdk|sdk-minimal|acp
  └─ boot: bundles + patches → Cordis plugin tree
       ctx.agents / ReactLoopAgent
         ├─ ctx.systemPrompt.assemble()  sections + contexts + tool schemas
         ├─ ctx.llm.prepareCall/stream   adapters: llm-deepseek, llm-pi-ai (multi-provider)
         └─ ctx.tools.execute            pre-execute → execute → post-execute waterfalls
               └─ ctx.approval / ctx.sandbox / ctx.fs / ctx.subprocess / ctx.jobs / spill
       Session = append-only SessionEvent log → ~/.dsh/sessions/<projectKey>/<id>/session.vN.jsonl[.zstd]
  Clients: web (HTTP + WebSocket Typert RPC, 127.0.0.1:3080) · Electron desktop (same web app)
           · headless one-shot · SDK (JSON-RPC over stdio) · ACP
```

## 2. Agent loop (`packages/core/agent-loop/src/agent.ts`, `ReactLoopAgent` L104) [code]

- **Inbox:** `send`, `followup` (next turn), `steer` (next step), `inject` (next step, no wake),
  and `cancel()`, which aborts the phase's AbortController.
- **Turn:** logs `turn/start`, then runs steps until done. The serial `agent/turn-stopping` event is
  the stop-hook point. It always logs `turn/end` with one of `completed | max-tokens | blocked |
  aborted | error`.
- **Pre-step:**
  1. Claims inbox messages.
  2. `ctx.tools.resolve()` sets the tools for this step.
  3. `systemPrompt.assemble()` builds the system prompt.
  4. The `agent/pre-step` waterfall can rewrite or reject the claimed messages.
- **Step:**
  1. The `agent/request` waterfall runs.
  2. The adapter's `prepareCall` binds the call.
  3. System and user events are logged, and the history is derived from the log.
  4. The model response streams in.
  5. The `agent/request-error` waterfall can return `retry`.
  6. `assistant/message` is logged.
  7. Tool calls run, up to 10 in parallel by default. A tool can call `concludeTurn()`.
- **Invariant:** what the model sees is logged, so every request can be rebuilt from the session log.
- **System prompt:** sections start with `harness:identity` ("…powered by DeepSeek Harness"), then a
  persona prefix and suffix. Plugins add the AGENTS.md chain, time and `@file` references.
- **DeepSeek adapter:** speaks the Anthropic-style Messages API at
  `https://api.deepseek.com/anthropic` (also configurable via `$DEEPSEEK_BASE_URL`) over SSE.
  Reasoning effort is `off|low|high|max` (default `high`). Default max tokens are 256k. The model
  catalog has `deepseek-flash` (1M context) and `deepseek-v4-pro`. Other providers come through
  `llm-pi-ai`.

## 3. Tools [code]

- **Registry and schemas:** `defineTool()` with a custom typed schema DSL. Arguments are compiled to
  JSON Schema and validated at runtime (`ToolArgsError`).
- **Output contract:** every tool returns a JSON value that is validated against `output.schema`,
  then `render()`ed to content blocks.
- **Two executors:**
  - **native** function calling;
  - **PTC** (`tool-executor-ptc`), where the model sees only `run_code` and the other tools appear as
    a generated SDK. This is the same idea as Codex's code mode.
- **Built-ins in base:**
  - Shell: `bash` (`pwsh` on Windows) with background jobs (`job_output`, `job_list`, `job_kill`).
  - Files: `read`, `write`, `edit`, `read_image`, `glob`, `grep`.
  - Skills and plugins: `skill`, `plugin_manager`.
  - Planning: `todo_write`, goal tools, `exit_plan_mode`.
  - Agents and workflows: `subagent`, `subagent_fork` and agent-control tools; `workflow`.
  - Web: `web_search`, `web_fetch`.
  - MCP resource tools.
- **Context hygiene:** `spill-policy` keeps at most 12.5k tokens inline and spills the rest to
  recoverable storage. Other plugins prune old tool results, enforce timeouts and send a reminder
  when a tool call repeats.

## 4. Safety [code]

- **Sandbox modes:** `SandboxMode = read-only | workspace-write | danger-full-access`. These cover
  file effects only; network is out of scope.
- **Runners:**

  | Platform | Runner | Enforcement |
  |---|---|---|
  | Linux | `bwrap`, then Landlock | full |
  | macOS | Seatbelt | full |
  | Windows | `windows-acl` restricted token, capability SID, Low integrity | **partial** |

  If no runner works, it fails closed.
- **Defaults:** `workspace-write` (or `$DSH_PERMISSION_MODE`), approval policy `ask`. Escalation goes
  one step at a time with a justification. A missing approver fails closed.
- **`fs-sandbox`:** path containment, which its own header says is "not a security boundary".
- **MCP stdio servers:** they start with a scrubbed environment but **not** inside the sandbox.

## 5. Extensibility & clients

- **MCP client:** stdio and streamable-HTTP, with tools named `mcp__<server>__<tool>`. No server is
  enabled by default.
- **Skills:** `.dsh/skills`, `.agents/skills`, `~/.dsh/skills`.
- **Subagent providers:** in-process spawn and fork, plus ACP, dsh-sdk, **Codex** and **Claude Code**.
- **Hooks:** only experimental bridges that read Claude Code and Codex `hooks.json` formats.
- **LSP:** opt-in.
- **Clients:**
  - No TUI at HEAD (it was removed).
  - Web UI is about 50 browser-side Cordis `ui-*` plugins.
  - SDK is JSON-RPC 2.0 over stdio (`initialize`, `session/prompt`, `session/resume`,
    `session/wait`), with TypeScript and Python clients.

---

## Side-by-side with the Codex desktop app

Codex details are in [codex-desktop-harness.md](codex-desktop-harness.md).

| | DeepSeek Harness | Codex desktop (26.1021 / CLI 0.164-alpha) |
|---|---|---|
| Core language | TypeScript / Node, Cordis plugin microkernel | Rust `codex app-server`; Electron ("Owl" Chromium fork) is only the UI |
| UI ↔ core | Typert RPC over HTTP + WebSocket; SDK JSON-RPC over stdio | JSON-RPC over stdio (`thread/*`, `turn/*`, `item/*`); ws/unix-socket daemon optional |
| Model API | Anthropic-style Messages (DeepSeek), plus pi-ai multi-provider | OpenAI Responses (GPT-6 family); `--oss` for Ollama / LM Studio |
| Tool surface | Many native tools by default; PTC `run_code` is optional | **Code mode by default**: one `exec` tool runs JS in a V8 isolate (`codex-code-mode-host.exe`) that calls `tools.exec_command`, `apply_patch`, MCP tools, etc. |
| Edits | `read`/`write`/`edit` tools | `apply_patch` |
| Sandbox | bwrap/Landlock, Seatbelt, Windows ACL (partial); file effects only | Restricted-token sandbox plus a LocalSystem sandbox service on Windows; same three mode names |
| Approvals | `ask`/`never`, stepwise escalation, auto-review (experimental) | `on-request`/`never`, `--approve-for-me` "guardian" auto-review, approval requests sent to the UI |
| Multi-agent | `subagent` / `subagent_fork`; can drive Codex or Claude Code as subagents | `spawn_agent`, `send_message`, `wait_agent`, … in a `/root` agent tree |
| Extensibility | Cordis plugins, YAML profile patches, skills, MCP, experimental hooks | Plugins (`.codex-plugin`): MCP + skills + hooks; ~150 feature flags; marketplace |
| Persistence | Append-only event log, JSONL + zstd generations per project | Local thread store / rollouts (resume, fork, archive); SQLite on the app side |

Two convergent ideas stand out. First, both harnesses can collapse many tools into one
"write code that calls tools" entry point (Codex `exec`, dsh PTC `run_code`). Second, both use the
same sandbox vocabulary (`read-only`, `workspace-write`, `danger-full-access`). The vocabulary
matches deliberately: dsh even ships Codex and Claude Code subagent providers and hook bridges.
