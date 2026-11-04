import fs from "node:fs";
import { type Ctx, type Node, finish, newBudget, reportLine, runTurn, settings, startMessages } from "./agent.js";
import { loadRole } from "./roles.js";

/* `qlaude --task task.json`: one task, no chat, no prompts. stdout gets only
   the JSON result, so another program (the Opus side) can call this. */

type TaskFile = {
  task: string;
  role?: string;
  check?: string;
  budget?: number;
  think?: boolean;
};

type Approve = "none" | "all";

export async function runHeadless(taskPath: string, opts: { role?: string; approve: Approve }) {
  settings.headless = true;
  const started = Date.now();
  try {
    const t: TaskFile = JSON.parse(fs.readFileSync(taskPath === "-" ? 0 : taskPath, "utf8"));
    if (typeof t.task !== "string" || !t.task.trim()) throw new Error('The task file needs a "task" string.');
    // Auto-approving everything is only safe where the agent can't reach the rest of the machine.
    if (opts.approve === "all" && process.env.QLAUDE_SANDBOX !== "1") {
      throw new Error("--approve all only runs inside the qlaude sandbox (QLAUDE_SANDBOX=1).");
    }
    if (t.think !== undefined) settings.think = t.think;

    const role = loadRole(t.role ?? opts.role ?? "solo");
    const node: Node = { role: role.name, task: t.task, check: t.check?.trim() || undefined, steps: 0, children: [] };
    const ctx: Ctx = {
      role,
      depth: 0,
      node,
      budget: t.budget ? { steps: t.budget } : newBudget(),
      ask: async (question) => {
        const ok = opts.approve === "all";
        process.stderr.write(`${question} ${ok ? "auto-approved" : "denied (headless)"}\n`);
        return ok;
      },
    };

    const result = await runTurn(startMessages(role, t.task, node.check), ctx);
    await finish(node, result, ctx);
    print({
      status: node.status,
      report: reportLine(node),
      steps: totalSteps(node),
      seconds: Math.round((Date.now() - started) / 1000),
      tree: node,
    });
  } catch (e) {
    print({ status: "error", error: e instanceof Error ? e.message : String(e) });
    process.exitCode = 2;
  }
}

const totalSteps = (n: Node): number => n.steps + n.children.reduce((sum, c) => sum + totalSteps(c), 0);

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
