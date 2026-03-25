#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VERBOSE = false;

const languages = {
  "fr-FR": "French (France)",
  "ja-JP": "Japanese (Japan)",
  "zh-CN": "Simplified Chinese (China)",
} as const;

const PROJECT_ROOT = process.cwd();
const I18N_DIR = path.join(PROJECT_ROOT, "data", "i18n");
const SOURCE_FILE = path.join(I18N_DIR, "en-US.json");

function isEnoentError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function cleanTranslatedJson(rawContent: string): string {
  return rawContent
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

function runTelocityOS(targetFile: string, inputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "os",
      "--file",
      inputFile,
      "--outfile",
      targetFile,
      "--params",
      "qwen",
    ];

    if (VERBOSE) console.log(`[EXEC]: telocity ${args.join(" ")}`);

    const child = spawn("telocity", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.end();

    child.stdout.on("data", (data: Buffer) => {
      if (VERBOSE) process.stdout.write(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      if (VERBOSE) process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });
  });
}

async function translationTask() {
  try {
    await stat(I18N_DIR);
    await stat(SOURCE_FILE);
  } catch (err) {
    if (isEnoentError(err)) {
      console.error(`Error: Path not found: ${err.path ?? "unknown"}`);
      process.exit(1);
    }
    throw err;
  }

  const sourceContent = await readFile(SOURCE_FILE, "utf-8");
  const sortedLangs = Object.keys(languages).sort();

  for (const lang of sortedLangs as (keyof typeof languages)[]) {
    const langName = languages[lang];
    const langFile = path.join(I18N_DIR, `${lang}.json`);

    try {
      await stat(langFile);
      console.log(`[-] Skipping ${langName} (Exists)`);
      continue;
    } catch (err) {
      if (!isEnoentError(err)) throw err;
    }

    const tempInputPath = path.join(
      os.tmpdir(),
      `telocity-temp-input-${Date.now()}.txt`,
    );
    try {
      console.log(`[+] Translating: ${langName}...`);

      const instruction = `Translate this JSON to ${langName}. Keep keys identical. Output valid JSON only.`;
      // prompt doubling version
      //const fullPayload = `${instruction}\n\n${sourceContent}\n\n${instruction}\n\n${sourceContent}`;
      const fullPayload = `${instruction}\n\n${sourceContent}`;

      await writeFile(tempInputPath, fullPayload, "utf-8");

      await runTelocityOS(langFile, tempInputPath);

      const rawOutput = await readFile(langFile, "utf-8");
      const cleanedOutput = cleanTranslatedJson(rawOutput);

      try {
        JSON.parse(cleanedOutput);
        await writeFile(langFile, cleanedOutput, "utf-8");
        console.log(`[OK] Saved ${langFile}`);
      } catch {
        console.error(
          `[!] Failed to parse LLM response for ${langName} as JSON.`,
        );
      }
    } catch (err) {
      console.error(
        `[FAIL] ${langName}:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      await unlink(tempInputPath).catch(() => {});
    }
  }
}

translationTask().catch(console.error);
