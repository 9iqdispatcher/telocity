#!/usr/bin/env bun

import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

const JSON_PATH = path.resolve(process.cwd(), "data/i18n/en-US.json");
const SRC_DIR = path.resolve(process.cwd(), "src");
const IGNORES = ["node_modules", "dist", "build", ".git"];
const FILE_EXT_WHITELIST = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".json",
  ".vue",
  ".svelte",
  ".html",
];

const COMMAND_MAP_KEYS = new Set([
  "tr",
  "tf",
  "bg",
  "rm",
  "cm",
  "st",
  "avg",
  "tc",
  "mg",
  "sp",
  "cfg",
  "os",
  "help",
  "lu",
  "rd",
  "co",
]);

const IGNORE_PREFIXES = ["help.generic.", "m.c.models."];

const IGNORE_SPECIFIC_KEYS = new Set([
  "m.c.rd.title",
  "m.c.rd.previousBtn",
  "m.c.rd.nextBtn",
  "m.c.rd.goToPage",
  "m.c.rd.pageInfo",
  "m.c.rd.pageInfoFallback",
  "m.c.rd.contentLoadError",
  "e.lcli.causePrefix",
]);

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!fs.existsSync(JSON_PATH)) {
  fail(`i18n JSON not found at ${JSON_PATH}`);
}

let rawJson: string;
try {
  rawJson = fs.readFileSync(JSON_PATH, "utf8");
} catch (err) {
  fail(`Failed to read ${JSON_PATH}: ${(err as Error).message}`);
}

let json: JsonValue;
try {
  json = JSON.parse(rawJson) as JsonValue;
} catch (err) {
  fail(`Failed to parse JSON at ${JSON_PATH}: ${(err as Error).message}`);
}

function flattenToLeaves(obj: JsonValue, prefix = ""): Map<string, string> {
  const map = new Map<string, string>();

  function walk(curr: JsonValue, pathSoFar: string) {
    if (curr === null || curr === undefined) return;
    if (typeof curr !== "object") {
      map.set(pathSoFar, String(curr));
      return;
    }
    if (Array.isArray(curr)) {
      curr.forEach((v, i) => walk(v, `${pathSoFar}[${i}]`));
      return;
    }

    for (const k of Object.keys(curr)) {
      const nextPath = pathSoFar ? `${pathSoFar}.${k}` : k;
      walk(curr[k]!, nextPath);
    }
  }

  walk(obj, prefix);
  return map;
}

const leaves = flattenToLeaves(json);
if (leaves.size === 0) {
  console.log("No leaf strings found in JSON. Nothing to check.");
  process.exit(0);
}

console.log(
  `Found ${leaves.size} leaf keys in ${path.relative(process.cwd(), JSON_PATH)}.`,
);

function rgAvailable(): boolean {
  try {
    child_process.execSync("rg --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getFilesWithRG(): string[] {
  try {
    const excludeArgs = IGNORES.map((g) => `--glob '!**/${g}/**'`).join(" ");
    const cmd = `rg --hidden --files "${SRC_DIR}" ${excludeArgs}`;
    const out = child_process.execSync(cmd, { encoding: "utf8" });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function getFilesNodeWalk(dir: string): string[] {
  const result: string[] = [];
  function walk(d: string) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const name = e.name;
      if (IGNORES.includes(name)) continue;
      const full = path.join(d, name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (FILE_EXT_WHITELIST.includes(ext)) result.push(full);
      }
    }
  }
  walk(dir);
  return result;
}

let files: string[] = [];
if (rgAvailable()) {
  files = getFilesWithRG();
  files = files.filter((f) =>
    FILE_EXT_WHITELIST.includes(path.extname(f).toLowerCase()),
  );
}
if (files.length === 0) {
  files = getFilesNodeWalk(SRC_DIR);
}

if (files.length === 0) {
  console.warn(
    "No source files found under src/. Make sure path and extensions are correct.",
  );
  process.exit(0);
}

console.log(`Scanning ${files.length} source files...`);

const fileContents = new Map<string, string>();
for (const f of files) {
  try {
    fileContents.set(f, fs.readFileSync(f, "utf8"));
  } catch {
    // skip unreadable files
  }
}

function buildSearchVariants(key: string): string[] {
  const variants = new Set<string>();
  variants.add(key);
  variants.add(`"${key}"`);
  variants.add(`'${key}'`);
  variants.add("`" + key + "`");
  const parts = key.split(".");
  if (parts.length > 0) {
    const singleQuoted = parts.map((p) => `['${p}']`).join("");
    const doubleQuoted = parts.map((p) => `["${p}"]`).join("");
    variants.add(singleQuoted);
    variants.add(doubleQuoted);
    variants.add(`i18n${singleQuoted}`);
    variants.add(`i18n${doubleQuoted}`);
  }
  variants.add(`get("${key}")`);
  variants.add(`get('${key}')`);
  variants.add(`t("${key}")`);
  variants.add(`t('${key}')`);
  variants.add(`i18n.t("${key}")`);
  variants.add(`i18n.t('${key}')`);
  variants.add(`translate("${key}")`);
  variants.add(`translate('${key}')`);

  return Array.from(variants);
}

function startsWithAnyPrefix(key: string, prefixes: string[]): boolean {
  for (const p of prefixes) if (key.startsWith(p)) return true;
  return false;
}

const unusedKeys: string[] = [];
const missingHelpCommands = new Map<string, string[]>();

let checked = 0;
for (const key of leaves.keys()) {
  checked++;

  if (IGNORE_SPECIFIC_KEYS.has(key)) {
    continue;
  }

  if (startsWithAnyPrefix(key, IGNORE_PREFIXES)) {
    continue;
  }

  if (key.startsWith("help.generic.")) {
    continue;
  }

  if (key.startsWith("help.commands.")) {
    const parts = key.split(".");
    const cmd = parts[2];

    if (cmd) {
      if (COMMAND_MAP_KEYS.has(cmd)) {
        continue;
      }
    }
  }

  const variants = buildSearchVariants(key);
  let found = false;

  for (const content of fileContents.values()) {
    if (content.indexOf(key) !== -1) {
      found = true;
      break;
    }
  }

  if (!found) {
    outer: for (const v of variants) {
      for (const content of fileContents.values()) {
        if (content.indexOf(v) !== -1) {
          found = true;
          break outer;
        }
      }
    }
  }

  if (!found) {
    if (key.startsWith("help.commands.")) {
      const parts = key.split(".");
      const cmd = parts[2] ?? "unknown";
      const arr = missingHelpCommands.get(cmd) ?? [];
      arr.push(key);
      missingHelpCommands.set(cmd, arr);
    } else {
      unusedKeys.push(key);
    }
  }
}

if (unusedKeys.length === 0 && missingHelpCommands.size === 0) {
  console.log("No unused i18n keys found.");
  process.exit(0);
}

console.log("\nUnused i18n keys summary:\n");

if (unusedKeys.length > 0) {
  console.log(`Standalone unused keys (${unusedKeys.length}):`);
  for (const k of unusedKeys) console.log("  " + k);
  console.log("");
}

if (missingHelpCommands.size > 0) {
  console.log(`Help subtrees for commands that do NOT exist in commandMap:\n`);
  for (const [cmd, keys] of missingHelpCommands.entries()) {
    console.log(`- command: "${cmd}" → ${keys.length} unused help key(s)`);
    const sample = keys.slice(0, 20);
    for (const k of sample) {
      console.log("    " + k);
    }
    if (keys.length > sample.length) {
      console.log(`    ...and ${keys.length - sample.length} more keys`);
    }
    console.log("");
  }
}

console.log(
  `Checked ${checked} leaf keys. Non-help unused: ${unusedKeys.length}. Missing help-commands groups: ${missingHelpCommands.size}.`,
);
console.log("Ignored prefixes:", IGNORE_PREFIXES.join(", "));
console.log(
  "Ignored specific keys:",
  Array.from(IGNORE_SPECIFIC_KEYS).join(", "),
);

const foundAny = unusedKeys.length > 0 || missingHelpCommands.size > 0;
if (foundAny) {
  console.log(
    "\nOne or more unused i18n keys were found. Failing with exit code 1 for CI.",
  );
  process.exit(1);
} else {
  console.log("\nNo unused keys found.");
  process.exit(0);
}
