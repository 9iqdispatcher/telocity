import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { type RunConcurOpts } from "../types/index.ts";
import { createError, x } from "./context.ts";

type TaskFn<R = unknown> = () => Promise<R>;
type ResultOf<T> = T extends () => Promise<infer R> ? R : never;

export function runConcur<T extends readonly TaskFn[]>(
  tasks: T,
  options?: { concurrency?: number },
): Promise<{ [K in keyof T]: ResultOf<T[K]> }>;

export function runConcur<T extends readonly TaskFn[]>(
  tasks: T,
  options: { concurrency?: number; allSettled: true },
): Promise<{ [K in keyof T]: PromiseSettledResult<ResultOf<T[K]>> }>;

export function runConcur<T extends readonly TaskFn[]>(
  tasks: T,
  options?: RunConcurOpts,
): Promise<unknown> {
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? 1));
  const allSettled = options?.allSettled ?? false;

  const len = tasks.length;
  if (len === 0) {
    return Promise.resolve([]) as Promise<{ [K in keyof T]: ResultOf<T[K]> }>;
  }

  return new Promise((resolve, reject) => {
    const results: unknown[] = Array.from({ length: len });
    const workerCount = Math.min(concurrency, len);

    let nextIndex = 0;
    let settledCount = 0;
    let hasRejected = false;

    async function worker(): Promise<void> {
      while (true) {
        if (hasRejected) return;

        const i = nextIndex++;
        if (i >= len) return;

        try {
          const value = await tasks[i]!();
          if (hasRejected) return;
          results[i] = allSettled
            ? ({
                status: "fulfilled",
                value,
              } as PromiseFulfilledResult<unknown>)
            : value;
        } catch (reason) {
          if (allSettled) {
            results[i] = {
              status: "rejected",
              reason,
            } as PromiseRejectedResult;
          } else {
            if (!hasRejected) {
              hasRejected = true;
              reject(
                reason instanceof Error ? reason : new Error(String(reason)),
              );
            }
            return;
          }
        } finally {
          settledCount++;
          if (settledCount === len) {
            if (!hasRejected) {
              resolve(results as { [K in keyof T]: unknown });
            }
          }
        }
      }
    }

    for (let i = 0; i < workerCount; i++) {
      void worker();
    }
  });
}

export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const abortMsg = x.a.s.e.lcli.processingAborted;
  if (signal.aborted) {
    return Promise.reject(
      createError(abortMsg, {
        code: "ABORT_ERR",
        immediateExitCode: false,
      }),
    );
  }
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      reject(
        createError(abortMsg, {
          code: "ABORT_ERR",
          immediateExitCode: false,
        }),
      );
    };

    signal.addEventListener("abort", handleAbort);

    promise.then(
      (val) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", handleAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const randomSuffix = randomBytes(4).toString("hex");
  const tempFilePath = path.join(dir, `.${base}.${randomSuffix}.tmp`);

  try {
    await writeFile(tempFilePath, data, { encoding, flag: "wx" });
    await rename(tempFilePath, filePath);
  } catch (err) {
    try {
      await unlink(tempFilePath);
    } catch {
      /* nothing */
    }
    throw err;
  }
}
