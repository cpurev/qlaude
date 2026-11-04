import fs from "node:fs";
import path from "node:path";

/* A map of the code without the code: every file, and for source files the
   names of what they define (functions with their parameters, classes, types).
   This is the only view of the codebase the planner gets. */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".qlaude"]);
const SOURCE = /\.(m?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift)$/;
const MAX_LINES = 400;

/* One pattern per language family. Group 1 is the name, group 2 (if any) the
   parameter list. Top-level definitions only, so nested helpers stay out. */
const SYMBOLS = [
  /^export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/,
  /^export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\))?/,
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/, // Python
  /^class\s+([A-Za-z_]\w*)/, // Python and others
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(\([^)]*\))?/, // Go
  /^(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/, // Rust
];

function symbolsOf(file: string): string[] {
  const names: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    for (const re of SYMBOLS) {
      const m = line.match(re);
      if (m) {
        names.push(m[2] ? `${m[1]}${m[2].replace(/\s+/g, " ")}` : m[1]);
        break;
      }
    }
  }
  return names;
}

export function repoMap(dir: string, root: string): string {
  if (!fs.existsSync(dir)) return "(empty: nothing has been built yet)";
  const lines: string[] = [];
  for (const entry of fs.globSync("**/*", { cwd: dir, withFileTypes: true, exclude: (d) => SKIP.has(d.name) })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, full);
    const symbols = SOURCE.test(entry.name) ? symbolsOf(full) : [];
    lines.push(symbols.length ? `${rel}: ${symbols.join(", ")}` : rel);
    if (lines.length >= MAX_LINES) {
      lines.push(`[stopped at ${MAX_LINES} files; pass a subfolder to see more]`);
      break;
    }
  }
  return lines.sort().join("\n") || "(empty: nothing has been built yet)";
}
