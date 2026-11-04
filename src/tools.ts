import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";

/* A small model picks the wrong tool more often the more tools it sees, so
   the set stays small and each description says exactly when to use it. */

const MAX_OUTPUT = 12_000; // ~3k tokens; a 32k context fills fast otherwise

export const truncate = (s: string) =>
  s.length <= MAX_OUTPUT
    ? s
    : `${s.slice(0, MAX_OUTPUT)}\n[truncated: ${s.length - MAX_OUTPUT} more characters. Narrow the request to see them.]`;

const fn = (
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required = Object.keys(properties),
): OpenAI.ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const TOOLS: OpenAI.ChatCompletionTool[] = [
  fn("list_files", "List files under a directory, recursively, optionally filtered by a glob. Skips node_modules and .git. Use this to find files by name.", {
    dir: { type: "string", description: "Directory path, e.g. \".\" or \"src\"" },
    pattern: { type: "string", description: "Optional glob, e.g. \"**/*.ts\" or \"src/**/*.test.js\"" },
  }, ["dir"]),
  fn("grep", "Search file contents with a regex. Returns matching lines as path:line:text. Use this to find where something is defined or used.", {
    pattern: { type: "string", description: "Regex to search for, e.g. \"function add\"" },
    path: { type: "string", description: "Optional file or directory to search, default \".\"" },
    glob: { type: "string", description: "Optional file filter, e.g. \"*.ts\"" },
  }, ["pattern"]),
  fn("read_file", "Read a text file. Always read a file before editing it.", {
    path: { type: "string", description: "File path" },
  }),
  fn("edit_file", "Replace one exact snippet in an existing file. `old` must appear exactly once; include a few surrounding lines to make it unique.", {
    path: { type: "string", description: "File path" },
    old: { type: "string", description: "Exact text to replace, copied from read_file output" },
    new: { type: "string", description: "Replacement text" },
  }),
  fn("write_file", "Create a new file, or fully overwrite a small one. Prefer edit_file for changes to existing files.", {
    path: { type: "string", description: "File path" },
    content: { type: "string", description: "Full file content" },
  }),
  fn("bash", "Run a shell command in the working directory, e.g. tests, git status, grep. Times out after 60s.", {
    command: { type: "string", description: "The command to run" },
  }),
];

/* Shell commands that only read. Each `|`-separated part must start with one
   of these; anything with redirects, substitution or chaining still asks. */
const SAFE_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "grep", "rg", "tree", "which"]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "blame"]);
const UNSAFE_CHARS = /[;&><`$()\n\\]/;
const UNSAFE_FLAGS = /--(output|pre|ext-diff|exec)\b/; // these make read-only commands write or run things

function isReadOnly(command: string): boolean {
  if (UNSAFE_CHARS.test(command) || UNSAFE_FLAGS.test(command)) return false;
  return command.split("|").every((part) => {
    const [cmd, sub] = part.trim().split(/\s+/);
    return cmd === "git" ? SAFE_GIT.has(sub) : SAFE_COMMANDS.has(cmd);
  });
}

/* Tools that change something ask the user first. */
export function needsApproval(name: string, args: Record<string, string>): boolean {
  if (name === "edit_file" || name === "write_file") return true;
  if (name === "bash") return !isReadOnly(args.command ?? "");
  return false;
}

const SKIP = new Set(["node_modules", ".git", "dist", ".next"]);
const MAX_FILES = 500;

function listFiles(dir: string, pattern = "**/*"): string {
  const files: string[] = [];
  for (const entry of fs.globSync(pattern, {
    cwd: dir,
    withFileTypes: true,
    exclude: (d) => SKIP.has(d.name),
  })) {
    if (!entry.isFile()) continue;
    files.push(path.relative(process.cwd(), path.join(entry.parentPath, entry.name)));
    if (files.length >= MAX_FILES) {
      files.push(`[stopped at ${MAX_FILES} files. Use a narrower dir or pattern.]`);
      break;
    }
  }
  return files.join("\n") || "No files matched.";
}

let hasRipgrep: boolean | undefined;

function grep(pattern: string, target = ".", glob?: string): string {
  hasRipgrep ??= (() => {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const [bin, args] = hasRipgrep
    ? ["rg", ["-n", "--no-heading", "--max-columns", "300", ...(glob ? ["-g", glob] : []), "-e", pattern, target]]
    : ["grep", ["-rnE", ...[...SKIP].map((d) => `--exclude-dir=${d}`), ...(glob ? [`--include=${glob}`] : []), "-e", pattern, target]];
  try {
    // execFile, not a shell: the model's pattern can't inject commands
    return execFileSync(bin, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 10_000_000 });
  } catch (e: any) {
    if (e.status === 1) return "No matches.";
    throw new Error(e.stderr || e.message);
  }
}

/* Throws on bad input; the agent loop turns the error into a tool result so
   the model sees its mistake and can retry. */
export function runTool(name: string, args: Record<string, string>): string {
  switch (name) {
    case "list_files":
      return listFiles(args.dir || ".", args.pattern || undefined);
    case "grep":
      return grep(args.pattern, args.path || ".", args.glob || undefined);
    case "read_file":
      return fs.readFileSync(args.path, "utf8");
    case "edit_file": {
      const text = fs.readFileSync(args.path, "utf8");
      const count = text.split(args.old).length - 1;
      if (count !== 1) {
        throw new Error(
          count === 0
            ? "`old` was not found. Read the file again and copy the text exactly."
            : `\`old\` appears ${count} times. Include more surrounding lines so it is unique.`,
        );
      }
      fs.writeFileSync(args.path, text.replace(args.old, () => args.new));
      return `Edited ${args.path}`;
    }
    case "write_file":
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      fs.writeFileSync(args.path, args.content);
      return `Wrote ${args.path}`;
    case "bash":
      try {
        return execSync(args.command, { encoding: "utf8", timeout: 60_000, stdio: "pipe" }) || "(no output)";
      } catch (e: any) {
        return `Exit code ${e.status ?? "?"}\n${e.stdout ?? ""}${e.stderr ?? e.message}`;
      }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
