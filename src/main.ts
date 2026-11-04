import readline from "node:readline/promises";
import type OpenAI from "openai";
import { type Ctx, newBudget, runTurn, settings, systemPrompt } from "./agent.js";
import { runHeadless } from "./headless.js";
import { listRoles, loadRole } from "./roles.js";

/* Flags: `--role backend` picks who you talk to (default: solo, a single
   agent that does the work itself). `--task file.json` runs headless. */
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const roleName = flag("--role");
const taskPath = flag("--task");
const approve = flag("--approve") ?? "none";

if (taskPath) {
  if (approve !== "none" && approve !== "all") {
    console.error("--approve must be none or all");
    process.exit(2);
  }
  await runHeadless(taskPath, { role: roleName, approve });
  process.exit();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => /^y/i.test(await rl.question(`${q} [y/N] `));

let role = loadRole(roleName ?? "solo");
const fresh = (): OpenAI.ChatCompletionMessageParam[] => [{ role: "system", content: systemPrompt(role) }];
let messages = fresh();
const ctx = (): Ctx => ({ role, depth: 0, budget: newBudget(), ask, node: { role: role.name, task: "", steps: 0, children: [] } });

/* `qlaude "do X"` runs one task and exits; plain `qlaude` opens a session. */
const oneShot = argv.join(" ").trim();
if (oneShot) {
  messages.push({ role: "user", content: oneShot });
  await runTurn(messages, ctx());
  rl.close();
} else {
  console.log(`qlaude (role: ${role.name}). /role <name> switches, /roles lists, /think toggles reasoning, /clear resets, /exit quits.`);
  while (true) {
    const input = (await rl.question("\n> ")).trim();
    if (!input) continue;
    if (input === "/exit") break;
    if (input === "/think") {
      settings.think = !settings.think;
      console.log(`Thinking ${settings.think ? "on (slower, better at hard tasks)" : "off"}.`);
      continue;
    }
    if (input === "/clear") {
      messages = fresh();
      console.log("Session cleared.");
      continue;
    }
    if (input === "/roles") {
      console.log(listRoles().map((r) => `- ${r}: ${loadRole(r).description}`).join("\n"));
      continue;
    }
    if (input.startsWith("/role ")) {
      try {
        role = loadRole(input.slice(6).trim());
        messages = fresh();
        console.log(`Now talking to ${role.name}. Session cleared.`);
      } catch (e) {
        console.log(e instanceof Error ? e.message : e);
      }
      continue;
    }
    messages.push({ role: "user", content: input });
    try {
      await runTurn(messages, ctx());
    } catch (e) {
      console.error(`Model request failed: ${e instanceof Error ? e.message : e}`);
      console.error("Is Ollama running (`ollama serve`) and the model created (`pnpm model`)?");
    }
  }
  rl.close();
}
