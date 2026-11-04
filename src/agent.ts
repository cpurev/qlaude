import { execSync } from "node:child_process";
import OpenAI from "openai";
import { type Role, loadRole } from "./roles.js";
import { TOOLS, needsApproval, runTool, truncate } from "./tools.js";

const client = new OpenAI({
  baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama", // required by the client, ignored by Ollama
});
const MODEL = process.env.QLAUDE_MODEL ?? "qlaude";
const MAX_STEPS = 30; // per agent; small models can loop forever
const MAX_DEPTH = 3; // each level summarizes the one below and loses detail

/* Thinking makes every step ~20x slower on a laptop, so it's off unless asked for. */
export const settings = { think: process.env.QLAUDE_THINK === "1", headless: false };

type Ask = (question: string) => Promise<boolean>;

/* One agent in the tree. The harness fills `status` from the check command,
   never from what the agent says about itself. */
export type Node = {
  role: string;
  task: string;
  check?: string;
  status?: "pass" | "fail" | "unchecked";
  summary?: string;
  note?: string;
  steps: number;
  children: Node[];
};

/* Everything an agent needs to run. `budget` is shared by the whole tree, so
   one confused worker can't spend the night looping. */
export type Ctx = { role: Role; depth: number; budget: { steps: number }; ask: Ask; node: Node; reserve?: number };

const RESERVE_PER_PARENT = 3; // steps kept back so every parent can still write its report
const MAX_BLOCKED_REPEATS = 3;

export const newBudget = () => ({ steps: Number(process.env.QLAUDE_BUDGET ?? 200) });

const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

/* Progress output, indented by tree depth so nested agents read as a tree.
   Headless mode sends it to stderr: stdout is reserved for the JSON result. */
let pad = "";
let atLineStart = true;
function out(s: string) {
  let r = "";
  for (const ch of s) {
    if (atLineStart && ch !== "\n") {
      r += pad;
      atLineStart = false;
    }
    r += ch;
    if (ch === "\n") atLineStart = true;
  }
  (settings.headless ? process.stderr : process.stdout).write(r);
}

export function systemPrompt(role: Role) {
  const children = role.children.map((name) => {
    try {
      return `- ${name}: ${loadRole(name).description}`;
    } catch {
      return `- ${name}`;
    }
  });
  return [
    `You are qlaude (role: ${role.name}), a coding agent working in ${process.cwd()}.`,
    "Use tools to look before you act: grep or list_files to find code, read_file to read it, then edit_file.",
    "Use bash for git, tests and other commands. Make the smallest change that does the job.",
    "Keep replies short. When you are done, end with ONE sentence describing what you built or changed. That sentence is your report.",
    role.prompt,
    children.length ? `You can delegate with spawn_agent to:\n${children.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const RUN_CHECK: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_check",
    description: "Run this task's check command exactly as it will be judged. Returns PASS, or FAIL with the output. Use this instead of running the check through bash.",
    parameters: { type: "object", properties: {} },
  },
};

function toolsFor(ctx: Ctx): OpenAI.ChatCompletionTool[] {
  const base = ctx.role.tools.length
    ? TOOLS.filter((t) => t.type === "function" && ctx.role.tools.includes(t.function.name))
    : [...TOOLS];
  if (ctx.node.check) base.push(RUN_CHECK);
  if (!ctx.role.children.length || ctx.depth >= MAX_DEPTH) return base;
  return [
    ...base,
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description:
          "Give one self-contained task to a child agent. It remembers nothing and sees nothing you saw: include the goal, the exact files, the interfaces, and a check command that proves it worked. Returns a one-line report: ✓ check passed, ✗ check failed, ? not checked.",
        parameters: {
          type: "object",
          properties: {
            role: { type: "string", enum: ctx.role.children, description: "Which child role" },
            task: { type: "string", description: "The full task, written for someone with no context" },
            check: { type: "string", description: "Shell command that exits 0 when the task is done, e.g. \"npx tsc --noEmit\" or \"node --test\"" },
          },
          required: ["role", "task", "check"],
        },
      },
    },
  ];
}

export type Result = { text: string; finished: boolean };

/* A fresh context for one task: the agent sees nothing else. */
export const startMessages = (role: Role, task: string, check?: string): OpenAI.ChatCompletionMessageParam[] => [
  { role: "system", content: systemPrompt(role) },
  { role: "user", content: check ? `${task}\n\nWhen you finish, your work is checked with: ${check}` : task },
];

/* One task for one agent: call the model, run the tools it asks for, repeat
   until it answers without a tool call. `messages` grows in place. */
export async function runTurn(messages: OpenAI.ChatCompletionMessageParam[], ctx: Ctx): Promise<Result> {
  let lastCall = "";
  let repeats = 0;
  let blocked = 0;
  let text = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    if (ctx.budget.steps <= (ctx.reserve ?? 0)) {
      out(gray("Stopped: the step budget for this task tree is used up.\n"));
      return { text, finished: false };
    }
    ctx.budget.steps--;
    ctx.node.steps++;
    pad = "  ".repeat(ctx.depth);

    const msg = await callModel(messages, toolsFor(ctx));
    messages.push(msg);
    if (typeof msg.content === "string" && msg.content.trim()) text = msg.content.trim();
    if (!msg.tool_calls?.length) return { text, finished: true };

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const { name, arguments: raw } = call.function;

      const key = name + raw;
      repeats = key === lastCall ? repeats + 1 : 0;
      lastCall = key;

      let output: string;
      try {
        if (repeats >= 2) {
          out(gray(`→ ${name} (blocked: repeated)\n`));
          if (++blocked >= MAX_BLOCKED_REPEATS) {
            out(gray("Stopped: kept repeating the same call.\n"));
            return { text, finished: false };
          }
          throw new Error("You already made this exact call twice. Try something different or finish.");
        }
        const args = JSON.parse(raw || "{}");
        if (name === "spawn_agent") {
          output = await spawn(args, ctx);
        } else if (name === "run_check") {
          out(gray(`→ run_check ${ctx.node.check}\n`));
          const c = await runCheck(ctx.node.check, ctx);
          output = c.status === "pass" ? "PASS" : c.status === "fail" ? `FAIL\n${c.output}` : `NOT RUN: ${c.note}`;
        } else {
          out(gray(`→ ${name} ${summarize(args)}\n`));
          if (needsApproval(name, args) && !(await ctx.ask(`${pad}allow ${name}?`))) {
            output = settings.headless
              ? "This action is not allowed in this run. Find another way, or finish and say what is blocked."
              : "The user denied this action. Ask what they want instead, or try another way.";
          } else {
            output = runTool(name, args);
          }
        }
      } catch (e) {
        output = `ERROR: ${e instanceof Error ? e.message : e}`;
      }
      pad = "  ".repeat(ctx.depth);
      messages.push({ role: "tool", tool_call_id: call.id, content: truncate(output) });
    }
  }
  out(gray(`Stopped after ${MAX_STEPS} steps.\n`));
  return { text, finished: false };
}

/* Runs a child agent on a fresh context, then runs the check itself. The
   ✓/✗ comes from the check, never from the child's own claim. */
async function spawn(args: { role: string; task: string; check?: string }, ctx: Ctx): Promise<string> {
  if (!ctx.role.children.includes(args.role)) {
    throw new Error(`You can only spawn: ${ctx.role.children.join(", ")}`);
  }
  const role = loadRole(args.role);
  const check = args.check?.trim() || undefined;
  const node: Node = { role: role.name, task: args.task, check, steps: 0, children: [] };
  ctx.node.children.push(node);
  const child: Ctx = { ...ctx, role, depth: ctx.depth + 1, node, reserve: (ctx.reserve ?? 0) + RESERVE_PER_PARENT };

  out(`▶ ${role.name}: ${oneLine(args.task, 120)}\n`);
  const result = await runTurn(startMessages(role, args.task, check), child);

  pad = "  ".repeat(ctx.depth);
  await finish(node, result, ctx);
  const report = reportLine(node);
  out(`${report}\n`);
  return report;
}

/* Fills a node's summary and status once its agent is done. */
export async function finish(node: Node, result: Result, ctx: Ctx) {
  node.summary = oneLine(result.text || "(no report)", 200);
  const { status, note } = await runCheck(node.check, ctx);
  node.status = status;
  node.note = [note, result.finished ? "" : "stopped early"].filter(Boolean).join("; ") || undefined;
}

const MARK = { pass: "✓", fail: "✗", unchecked: "?" } as const;

export const reportLine = (node: Node) =>
  `${MARK[node.status ?? "unchecked"]} ${node.role}: ${node.summary ?? "(no report)"}${node.note ? ` [${node.note}]` : ""}`;

type Check = { status: Node["status"]; note: string; output: string };

async function runCheck(check: string | undefined, ctx: Ctx): Promise<Check> {
  if (!check) return { status: "unchecked", note: "no check", output: "" };
  if (needsApproval("bash", { command: check }) && !(await ctx.ask(`${pad}run check \`${check}\`?`))) {
    return { status: "unchecked", note: "check not run", output: "" };
  }
  try {
    execSync(check, { encoding: "utf8", timeout: 120_000, stdio: "pipe" });
    return { status: "pass", note: "", output: "" };
  } catch (e: any) {
    const lines = `${e.stdout ?? ""}${e.stderr ?? e.message}`.trim().split("\n").filter(Boolean);
    return {
      status: "fail",
      note: `check failed: ${oneLine(lines.at(-1) ?? "(no output)", 120)}`,
      output: truncate(lines.slice(-20).join("\n") || "(no output, non-zero exit)"),
    };
  }
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/* Streams one model reply to the terminal and returns it as a message.
   Reasoning (when thinking is on) prints dimmed; Ollama sends it as
   `delta.reasoning`, which isn't in the OpenAI types. */
async function callModel(
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
): Promise<OpenAI.ChatCompletionAssistantMessageParam> {
  const started = Date.now();
  const spinner = setInterval(() => {
    if (settings.headless) return;
    process.stdout.write(`\r${pad}${gray(`waiting for model… ${Math.round((Date.now() - started) / 1000)}s`)}`);
  }, 250);
  let spinning = true;
  const stopSpinner = () => {
    if (!spinning) return;
    spinning = false;
    clearInterval(spinner);
    if (!settings.headless) process.stdout.write("\r\x1b[2K");
  };

  let content = "";
  let inReasoning = false;
  const calls: { id: string; name: string; args: string }[] = [];

  try {
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      stream: true,
      reasoning_effort: settings.think ? "medium" : ("none" as any),
    });

    for await (const chunk of stream) {
      const delta: any = chunk.choices[0]?.delta ?? {};
      if (delta.reasoning) {
        stopSpinner();
        inReasoning = true;
        out(gray(delta.reasoning));
      }
      if (delta.content) {
        stopSpinner();
        if (inReasoning) {
          out("\n\n");
          inReasoning = false;
        }
        content += delta.content;
        out(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
  } finally {
    stopSpinner();
  }
  if (content || inReasoning) out("\n");

  return {
    role: "assistant",
    content: content || null,
    ...(calls.length && {
      tool_calls: calls.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    }),
  };
}

function summarize(args: Record<string, string>) {
  if (args.command) return args.command;
  if (args.pattern) return `${args.pattern}${args.path ? ` in ${args.path}` : ""}${args.glob ? ` (${args.glob})` : ""}`;
  return args.path ?? args.dir ?? "";
}
