# qlaude

A lightweight coding-agent harness in the spirit of Claude Code, built to run on a local Qwen model (Qwen3.5-9B through Ollama). No API keys, no cloud: the model runs on your machine.

It's deliberately small, because a 9B model gets worse with every extra tool and every long prompt:

- **Claude Code-style terminal agent**: interactive sessions or one-shot tasks, six tools (`list_files`, `grep`, `read_file`, `edit_file`, `write_file`, `bash`), approval prompts for anything that changes your files, read-only commands run without asking.
- **Built for a small model**: short system prompt, errors fed back so the model can correct itself, capped tool output, step limits and repeat detection, thinking off by default (about 1s per step instead of 20s on an M4).
- **Agent trees**: lead roles split work and hand it to worker agents. Every task has a check command, and qlaude runs it itself, so ✓/✗ reflects what actually works, not what the agent claims.
- **Headless mode and a Docker sandbox** for unattended runs.
- **Optional planner**: an MCP server lets Claude Code act as the planner while qlaude agents write the code.

Not affiliated with Anthropic. "Claude Code" is used here only to describe the style of tool.

## Setup

Needs Node 22+, pnpm, Ollama, and Docker for the sandbox. Developed on an Apple Silicon Mac with 16 GB.

```bash
brew install ollama
ollama serve                    # keep running
ollama pull qwen3.5:9b

git clone https://github.com/cpurev/qlaude && cd qlaude
pnpm install
pnpm model                      # creates the `qlaude` model: qwen3.5:9b with a 32k context
docker build -t qlaude .        # the sandbox image

# put the commands on your PATH
for c in qlaude qlaude-sandbox qlaude-mcp qlaude-new; do ln -sf "$PWD/bin/$c" ~/.local/bin/$c; done
```

## Use

```bash
# from any project directory
qlaude                          # interactive session
qlaude "fix the failing test in math.test.js"
```

Edits, file writes and shell commands ask for approval (`y`). Read-only commands run without asking: `git status/diff/log/show/blame`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `tree`, `pwd`, `which`, and pipes between them. Anything with `;`, `&`, redirects or `$(...)` still asks. In a session, `/think` toggles reasoning, `/clear` resets the conversation and `/exit` quits.

Thinking is off by default: on an M4 it makes each step take ~20s instead of ~1s. Turn it on for harder tasks.

Environment overrides: `QLAUDE_MODEL` (default `qlaude`), `OLLAMA_URL` (default `http://localhost:11434/v1`), `QLAUDE_THINK=1` (start with thinking on).

## How it works

- `src/main.ts`: the REPL and one-shot mode.
- `src/agent.ts`: the loop. Call the model, run the tools it asks for, send results back, repeat until it answers with no tool call. Stops after 30 steps or when the same call repeats three times.
- `src/tools.ts`: six tools (`list_files` with an optional glob, `grep` using ripgrep or grep, `read_file`, `edit_file`, `write_file`, `bash`). Errors go back to the model as tool results so it can correct itself; output is capped at 12k characters to protect the context window.

## Roles and agent trees

```bash
qlaude --role backend "add a /health endpoint that returns {ok: true}"
```

A role is a markdown file in `roles/` (or a project's `.qlaude/roles/`, which overrides):

```markdown
---
name: backend
description: One line, shown to whoever can spawn this role.
tools: [list_files, grep, read_file, write_file, bash]   # omit for all tools
children: [worker]                                        # roles it may spawn
---
Instructions for the role.
```

Built in: `solo` (default, does the work itself), `worker` (one small task), and the leads `backend`, `ui`, `cicd`, which split work into worker tasks and keep notes in `.qlaude/notes/<role>.md`.

A role with children gets a `spawn_agent(role, task, check)` tool. The child starts with a fresh context, and when it finishes **qlaude runs the check command itself** and returns one line to the parent:

```
✓ worker: Added server/health.ts exporting health() returning {ok: true}.
✗ worker: Added the route. [check failed: TypeError: health is not a function]
? worker: Updated the README. [no check]
```

Limits: depth 3, 30 steps per agent, and a step budget shared by the whole tree (`QLAUDE_BUDGET`, default 200). In a session: `/roles` lists roles, `/role <name>` switches.

## Headless mode

For other programs (the Opus side). No chat, no prompts; stdout is only JSON, progress goes to stderr.

```bash
qlaude --task task.json            # or: echo '{...}' | qlaude --task -
```

```json
{ "task": "Add server/health.js exporting health() that returns {ok: true}",
  "role": "backend",              // optional, default solo (or --role)
  "check": "node --test server/", // optional; run by the harness, decides ✓/✗
  "budget": 60,                   // optional step budget for the whole tree
  "think": false }                // optional
```

Result:

```json
{ "status": "pass", "report": "✓ backend: Added server/health.js …", "steps": 12, "seconds": 48, "tree": { … } }
```

`status` is `pass`, `fail`, `unchecked` or `error` (exit code 2: bad task file or harness error). `report` is the one line a planner should read; `tree` has every agent's task, check, status and summary for debugging.

Approvals: `--approve none` (default) runs only read-only actions and denies the rest. `--approve all` runs everything, and qlaude refuses it unless `QLAUDE_SANDBOX=1`, which only the sandbox sets.

Agents with a check also get a `run_check` tool that runs it exactly as it will be judged. Each parent keeps 3 steps of the shared budget in reserve so it can always report, and an agent that repeats a blocked call 3 times is stopped.

## Sandbox (Docker)

Fully autonomous runs (`--approve all`) only work inside the sandbox. The model stays on the Mac (Docker on macOS can't use the Apple GPU); the container reaches Ollama at `host.docker.internal:11434`.

```bash
docker build -t qlaude .                                    # after changing src/ or roles/
cd ~/some-project
qlaude-sandbox --task task.json --approve all               # task file must be inside the project
echo '{"task": "..."}' | qlaude-sandbox --task - --approve all
```

`qlaude-sandbox` mounts only the current directory at `/work` and runs as your user with all Linux capabilities dropped, `no-new-privileges`, 2 GB memory, 4 CPUs and 256 processes. Inside, the agent can't see your home folder, SSH keys or cloud credentials, and can't write outside `/work`.

Not restricted yet: outbound network. The agent can reach the internet (e.g. `npm install`). Treat the project folder itself as fully writable by the agent: commit before a run so you can review or revert with git.

## Optional: Claude Code as the planner

```bash
qlaude-new ~/projects/todo        # scaffold a planner project
# write ~/projects/todo/SPEC.md
cd ~/projects/todo
MCP_TOOL_TIMEOUT=3600000 claude --strict-mcp-config --mcp-config .mcp.json
```

```
~/projects/todo/
  CLAUDE.md               planner role: contracts first, self-contained tasks, every task has a check
  SPEC.md                 what you want (you write this)
  PLAN.md                 the planner's plan and status
  contracts/              API shapes, shared types, layout; copied into app/contracts/ before each dispatch
  .claude/settings.json   deny Read/Edit of app/, deny Bash and Grep; allow goldfish tools, PLAN.md, contracts/
  .mcp.json               starts the goldfish MCP server (bin/qlaude-mcp app)
  app/                    the code; only the workers touch it
    .qlaude/tasks/        every task dispatched
    .qlaude/runs/         every result, with the full agent tree
```

The goldfish MCP server (`src/mcp.ts`) gives the planner three tools:

- `repo_map(path?)`: files, plus function/class names with parameters. No code bodies.
- `dispatch(role, task, check, budget?, think?)`: runs `qlaude-sandbox --task … --approve all` in `app/` and returns one line plus a run id. Runs are queued one at a time.
- `run_log(id)`: one line per agent of a run (status, summary, task) for diagnosing ✗.

`--strict-mcp-config` keeps your other MCP servers out of the planner's context. `MCP_TOOL_TIMEOUT` (and the per-server `timeout` in `.mcp.json`) gives long dispatches up to an hour.
