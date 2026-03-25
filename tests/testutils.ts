import { vi } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as appCore from "../src/libs/core/index.ts";
import {
  deleteProgressEntry,
  stripGarbageNewLines,
} from "../src/libs/LLM/index.ts";

let initialized: boolean;
export let appState: Awaited<ReturnType<typeof appCore.configInit>>;
export const SOURCE_FILE = "./tests/data/source.txt";
export const SOURCE_FILE2 = "./tests/data/source2.txt";
export let sourceFileContent: string;
export let sourceFileContent2: string;
export let sourceFileHash: string;
export let sourceFileHash2: string;

export async function initTest() {
  if (initialized) return;
  appState = await appCore.configInit(true);
  sourceFileContent = await fs.readFile(SOURCE_FILE, "utf-8");
  sourceFileContent2 = await fs.readFile(SOURCE_FILE2, "utf-8");

  sourceFileHash = appCore.fastHash(stripGarbageNewLines(sourceFileContent));
  sourceFileHash2 = appCore.fastHash(stripGarbageNewLines(sourceFileContent2));
  initialized = true;
}

export async function withCapturedConsole(fn: () => Promise<void>) {
  const capturedChunks: string[] = [];
  const spies = [];
  const captureImplementation = (...args: unknown[]) => {
    const line = args
      .map((arg) => {
        if (Buffer.isBuffer(arg)) return arg.toString();
        if (typeof arg === "object" && arg !== null) return JSON.stringify(arg);
        return String(arg);
      })
      .join(" ");

    capturedChunks.push(line);
    return true;
  };

  spies.push(
    vi
      .spyOn(appCore, "log")
      .mockImplementation(
        captureImplementation as unknown as typeof appCore.log,
      ),
  );
  spies.push(
    vi
      .spyOn(appCore, "errlog")
      .mockImplementation(
        captureImplementation as unknown as typeof appCore.errlog,
      ),
  );

  await fn();

  spies.forEach((spy) => spy.mockRestore());
  return capturedChunks.join("\n");
}

export async function cleanupProgressEntryForSource() {
  try {
    await deleteProgressEntry(sourceFileHash);
    await deleteProgressEntry(sourceFileHash2);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

export type TestEnvironment = {
  tmpDir: string;
  outDir: string;
  targetFile: string;
  originalStateDir: string;
};

export async function setupTestEnvironment(): Promise<TestEnvironment> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-test-"));
  const outDir = path.join(tmpDir, "output");
  await fs.mkdir(outDir, { recursive: true });
  const targetFile = path.join(outDir, "processed.txt");

  const originalStateDir = appState.STATE_DIR;
  Object.defineProperty(appState, "STATE_DIR", {
    value: path.join(tmpDir, "state"),
    writable: true,
    configurable: true,
  });
  await fs.mkdir(appState.STATE_DIR, { recursive: true });

  return { tmpDir, outDir, targetFile, originalStateDir };
}

export async function teardownTestEnvironment({
  tmpDir,
  originalStateDir,
}: Partial<TestEnvironment>): Promise<void> {
  if (originalStateDir) {
    const appState = appCore.AppStateSingleton.getInstance();
    Object.defineProperty(appState, "STATE_DIR", {
      value: originalStateDir,
      writable: true,
      configurable: true,
    });
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
