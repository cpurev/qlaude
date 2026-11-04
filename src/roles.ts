import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* A role is a markdown file: frontmatter for name, description, tools and the
   child roles it may spawn, then the role's instructions. A project can add or
   override roles in .qlaude/roles/; the rest come from qlaude's roles/. */

export type Role = {
  name: string;
  description: string;
  tools: string[]; // empty means every base tool
  children: string[];
  prompt: string;
};

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "roles");
const roleDirs = () => [path.join(process.cwd(), ".qlaude", "roles"), BUILTIN];

export function loadRole(name: string): Role {
  for (const dir of roleDirs()) {
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file)) return parseRole(name, fs.readFileSync(file, "utf8"));
  }
  throw new Error(`No role "${name}". Available: ${listRoles().join(", ")}`);
}

export function listRoles(): string[] {
  const names = new Set<string>();
  for (const dir of roleDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) names.add(f.slice(0, -3));
  }
  return [...names].sort();
}

function parseRole(fallbackName: string, text: string): Role {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (v = "") =>
    v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    name: meta.name || fallbackName,
    description: meta.description ?? "",
    tools: list(meta.tools),
    children: list(meta.children),
    prompt: (match?.[2] ?? text).trim(),
  };
}
