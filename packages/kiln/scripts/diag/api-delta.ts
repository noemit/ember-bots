#!/usr/bin/env bun
/**
 * What of Hearth's dependency surface survives a pi-durable/chord/pi-ai upgrade.
 *
 * Collects every named import from the four `@earendil-works` packages across `src/` and `test/`, and
 * checks each against the target version's `.d.ts` files, printing the symbols that are gone. Run it
 * before any upgrade to size the work, and again after to prove nothing was missed:
 *
 *   bun scripts/diag/api-delta.ts                     # 1.4.0 (installed) -> 1.5.0 (bun cache)
 *   bun scripts/diag/api-delta.ts 1.5.0 1.5.0         # same version, sanity check
 *
 * Measured 2026-11-04 (1.4.0 vs 1.5.0): pi-durable loses `watchEvents` and `AgentEventStream` of 57
 * symbols used; pi-ai loses `Type` and `TSchema` of 36; chord and pi-codemode are clean.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "1.5.0";
// Bun's cache location differs by platform and Bun version; try both known layouts.
const candidates = [
  join(homedir(), ".cache/.bun/install/cache/@earendil-works"),
  join(homedir(), ".bun/install/cache/@earendil-works"),
];
const CACHE = candidates.find((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory()) ?? candidates[0]!;
const PKGS: Record<string, string> = {
  "pi-durable": CACHE + "/pi-durable@" + target + "@@@1/dist",
  "pi-ai": CACHE + "/pi-ai@" + target + "@@@1/dist",
  "pi-codemode": CACHE + "/pi-codemode@" + target + "@@@1/dist",
  chord: CACHE + "/chord@" + target + "@@@1/dist",
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".d.ts")) out.push(path);
  }
  return out;
};

const surface = new Map<string, string>();
for (const [pkg, dir] of Object.entries(PKGS)) {
  let text = "";
  try {
    text = walk(dir).map((file) => readFileSync(file, "utf8")).join("\n");
  } catch {
    continue;
  }
  surface.set(pkg, text);
}
const has = (pkg: string, name: string): boolean => {
  const text = surface.get(pkg);
  if (!text) return false;
  const patterns = [
    new RegExp("export (?:declare )?(?:const|let|var|function|class|type|interface|enum) " + name + "\\b"),
    new RegExp("export \\{[^}]*\\b" + name + "\\b[^}]*\\}"),
    new RegExp("\\b" + name + "[,}]"),
  ];
  return patterns.some((pattern) => pattern.test(text));
};

// Every named import from the four packages across src/ and test/.
const sources: string[] = [];
const walkSrc = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkSrc(path);
    else if (path.endsWith(".ts")) sources.push(path);
  }
};
walkSrc("src");
walkSrc("test");

const used = new Map<string, Set<string>>();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const re = /import(?:\s+type)?\s*\{([^}]+)\}\s*from\s*"(@earendil-works\/([a-z-]+)(?:\/[a-z/]+)?)"/g;
  for (const match of text.matchAll(re)) {
    const pkg = match[3]!;
    if (!surface.has(pkg)) continue;
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!used.has(pkg)) used.set(pkg, new Set());
      used.get(pkg)!.add(name);
    }
  }
}
for (const [pkg, names] of [...used].sort()) {
  const missing = [...names].filter((name) => !has(pkg, name)).sort();
  console.log("\n" + pkg + ": " + names.size + " symbols used, " + missing.length + " NOT in " + target);
  if (missing.length > 0) console.log("  missing: " + missing.join(", "));
}
