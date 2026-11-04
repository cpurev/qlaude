import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { repoMap } from "./repomap.js";

/* The bridge between Claude Code (Opus, the planner) and qlaude (Qwen, the
   workers). Claude Code starts it from the planner project's .mcp.json with
   the code folder as the argument. Opus never sees code through it: only a
   map of names, one-line reports, and one line per agent when a run fails.
   stdout belongs to the MCP protocol, so nothing here may print to it. */

const exec = promisify(execFile);
const root = process.cwd();
const workspace = path.resolve(root, process.argv[2] ?? "app");
const SANDBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "qlaude-sandbox");

const stateDir = (name: string) => {
  const dir = path.join(workspace, ".qlaude", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const oneLine = (s: string, max = 160) => {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/* Opus writes contracts/ next to the plan; workers only see the workspace, so
   copy them in before every run. Workers are told never to change them. */
function syncContracts() {
  const src = path.join(root, "contracts");
  if (fs.existsSync(src)) fs.cpSync(src, path.join(workspace, "contracts"), { recursive: true, force: true });
}

/* One run at a time: the Mac has one model and 16 GB. */
let queue: Promise<unknown> = Promise.resolve();
const serially = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

type Node = { role: string; task: string; status?: string; summary?: string; note?: string; children: Node[] };
type RunResult = { status: string; report?: string; error?: string; steps?: number; seconds?: number; tree?: Node };

const MARK: Record<string, string> = { pass: "✓", fail: "✗", unchecked: "?" };

async function dispatch(args: { role: string; task: string; check: string; budget?: number; think?: boolean }) {
  fs.mkdirSync(workspace, { recursive: true });
  syncContracts();
  const id = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${args.role}`;
  const taskFile = path.join(stateDir("tasks"), `${id}.json`);
  fs.writeFileSync(taskFile, JSON.stringify(args, null, 2));

  let result: RunResult;
  try {
    const { stdout } = await exec(SANDBOX, ["--task", path.relative(workspace, taskFile), "--approve", "all"], {
      cwd: workspace,
      maxBuffer: 50_000_000,
    });
    result = JSON.parse(stdout);
  } catch (e: any) {
    // qlaude exits 2 on harness errors but still prints JSON; anything else is Docker or the sandbox failing
    try {
      result = JSON.parse(e.stdout);
    } catch {
      result = { status: "error", error: oneLine(e.stderr || e.message, 300) };
    }
  }
  fs.writeFileSync(path.join(stateDir("runs"), `${id}.json`), JSON.stringify(result, null, 2));

  const line = result.report ?? `! error: ${result.error ?? "unknown"}`;
  return `${line}\n(run ${id}: ${result.steps ?? 0} steps, ${result.seconds ?? 0}s)`;
}

function runLog(id: string): string {
  const file = path.join(workspace, ".qlaude", "runs", `${path.basename(id)}.json`);
  if (!fs.existsSync(file)) return `No run "${id}".`;
  const result: RunResult = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!result.tree) return `! error: ${result.error ?? "no tree"}`;
  const lines: string[] = [];
  const walk = (n: Node, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}${MARK[n.status ?? "unchecked"] ?? "?"} ${n.role}: ${oneLine(n.summary ?? "(no report)")}${n.note ? ` [${n.note}]` : ""}`);
    lines.push(`${pad}  task: ${oneLine(n.task, 140)}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(result.tree, 0);
  return lines.join("\n");
}

const server = new McpServer({ name: "goldfish", version: "0.1.0" });

server.registerTool(
  "repo_map",
  {
    description:
      "Map of the code the workers have built: every file, and for source files the names of what they define (functions with parameters, classes, types). No code bodies. Use it to write precise tasks.",
    inputSchema: { path: z.string().optional().describe("Subfolder of the code, e.g. \"server\". Default: everything.") },
  },
  async ({ path: sub }) => text(repoMap(path.join(workspace, sub ?? "."), workspace)),
);

server.registerTool(
  "dispatch",
  {
    description:
      "Give one task to a worker team and wait for it to finish (can take many minutes). Roles: backend, ui, cicd (leads that split work into workers), worker (one small task), or a project role from .qlaude/roles. The team remembers nothing: the task must contain the goal, the files or area, the relevant contracts/ paths, and every constraint. Returns one line: ✓ the check passed, ✗ it failed, ? not checked.",
    inputSchema: {
      role: z.string().describe("backend, ui, cicd, worker, or a project role"),
      task: z.string().describe("The full task, written for someone with no context"),
      check: z.string().describe("Shell command run in the code folder that exits 0 only when the task is done, e.g. \"npm test\""),
      budget: z.number().int().positive().optional().describe("Step budget for the whole team. Default 200."),
      think: z.boolean().optional().describe("Let the workers reason before acting. Slower; use for hard tasks."),
    },
  },
  async (args) => text(await serially(() => dispatch(args))),
);

server.registerTool(
  "run_log",
  {
    description:
      "One line per agent of a finished run (status, summary, the task it was given). Use when a dispatch returned ✗ or ? to see which agent failed and why. No code.",
    inputSchema: { id: z.string().describe("The run id from a dispatch result") },
  },
  async ({ id }) => text(runLog(id)),
);

await server.connect(new StdioServerTransport());
