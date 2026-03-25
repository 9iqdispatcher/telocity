// This file was entirely LLM generated, here be dragons.

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { TokenizerConfig, TokenizerJSON } from "./tokenizertypes.ts";

import {
  createError,
  errlog,
  isEnoentError,
  simpleTemplate,
  x,
} from "../core/index.ts";

async function loadTokenizerData(
  tokenizerName: string,
): Promise<[TokenizerJSON, TokenizerConfig] | null> {
  const { a } = x;
  const modelsDir = path.join(a.STATE_DIR, "models");

  const tokenizerJsonPath = path.join(modelsDir, `${tokenizerName}.json`);
  const tokenizerConfigPath = path.join(
    modelsDir,
    `${tokenizerName}_config.json`,
  );

  try {
    const [tokenizerJsonStr, tokenizerConfigStr] = await Promise.all([
      readFile(tokenizerJsonPath, "utf-8"),
      readFile(tokenizerConfigPath, "utf-8"),
    ]);

    return [JSON.parse(tokenizerJsonStr), JSON.parse(tokenizerConfigStr)];
  } catch (err) {
    if (isEnoentError(err)) {
      throw createError(
        simpleTemplate(a.s.e.c.tc.tokenizerFilesNotFound, {
          TokenizerName: tokenizerName,
          JsonPath: tokenizerJsonPath,
          ConfigPath: tokenizerConfigPath,
        }),
        { code: "ENOENT", cause: err },
      );
    }
    throw err;
  }
}

let sharedBufferCache:
  | Map<
      string,
      Promise<{
        sharedTokenizerBuffer: SharedArrayBuffer;
        sharedConfigBuffer: SharedArrayBuffer;
      }>
    >
  | undefined;

// oxlint-disable-next-line require-await
async function getSerializedSharedBuffers(tokenizerName: string) {
  if (sharedBufferCache === undefined) {
    sharedBufferCache = new Map();
  }

  const cacheKey = `${tokenizerName}_serialized_shared`;

  if (!sharedBufferCache.has(cacheKey)) {
    const promise = (async () => {
      const loadedData = await loadTokenizerData(tokenizerName);
      const { a } = x;

      if (!loadedData) {
        throw createError(
          simpleTemplate(a.s.e.c.tc.tokenizerFilesNotFound, {
            TokenizerName: tokenizerName,
          }),
          { code: "TOKENIZER_NOT_FOUND" },
        );
      }

      const [tokenizerJSON, tokenizerConfig] = loadedData;
      const encoder = new TextEncoder();
      const tokenizerBytes = encoder.encode(JSON.stringify(tokenizerJSON));
      const configBytes = encoder.encode(JSON.stringify(tokenizerConfig));

      const sharedTokenizerBuffer = new SharedArrayBuffer(
        tokenizerBytes.byteLength,
      );
      new Uint8Array(sharedTokenizerBuffer).set(tokenizerBytes);

      const sharedConfigBuffer = new SharedArrayBuffer(configBytes.byteLength);
      new Uint8Array(sharedConfigBuffer).set(configBytes);

      return { sharedTokenizerBuffer, sharedConfigBuffer };
    })();

    sharedBufferCache.set(cacheKey, promise);
  }

  return sharedBufferCache.get(cacheKey)!;
}

interface ParallelCountInput {
  text: string;
  text_pair?: string | null;
  options?: { add_special_tokens?: boolean };
}

interface WorkerPayload {
  tokenizerName: string;
  sharedTokenizerBuffer: SharedArrayBuffer;
  sharedConfigBuffer: SharedArrayBuffer;
  inputs: ParallelCountInput[];
}

interface WorkerReadyResponse {
  type: "ready";
  memoryUsage: number;
}

interface WorkerSuccessResponse {
  jobId: number;
  results: number[];
  memoryUsage?: number;
}

interface WorkerErrorResponse {
  jobId: number;
  error: { message: string; stack?: string };
}

type WorkerResponse =
  | WorkerReadyResponse
  | WorkerSuccessResponse
  | WorkerErrorResponse;

class TokenWorkerPool {
  private static instance: TokenWorkerPool;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskCallbacks = new Map<
    number,
    { resolve: (value: number[]) => void; reject: (reason?: unknown) => void }
  >();
  private workerToJob = new Map<Worker, number>();
  private requestQueue: Array<{
    resolve: (worker: Worker) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private nextJobId = 0;
  private isInitialized = false;
  private isShuttingDown = false;
  private calibrationPromise: Promise<void> | null = null;

  private workerFactory: (() => Worker) | null = null;

  private maxMemoryPerWorker: number = 50 * 1024 * 1024;
  private readonly HARD_MAX_WORKERS = Math.min(cpus().length, 16);

  private initParams?: {
    tokenizerName: string;
    sharedTokenizerBuffer: SharedArrayBuffer;
    sharedConfigBuffer: SharedArrayBuffer;
  };

  private constructor() {}

  public static getInstance(): TokenWorkerPool {
    if (!TokenWorkerPool.instance) {
      TokenWorkerPool.instance = new TokenWorkerPool();
    }
    return TokenWorkerPool.instance;
  }

  public get currentTargetPoolSize() {
    return this.calculateTargetPoolSize();
  }

  private calculateTargetPoolSize(): number {
    const currentWorkerRam = this.workers.length * this.maxMemoryPerWorker;

    const totalFreeIfNoWorkers = freemem() + currentWorkerRam;
    const systemTotalRam = totalmem();

    const systemReserved = Math.max(1024 * 1024 * 1024, systemTotalRam * 0.2);
    let budget = totalFreeIfNoWorkers - systemReserved;

    budget = Math.min(budget, systemTotalRam * 0.5);

    if (budget < this.maxMemoryPerWorker) {
      return 1;
    }

    const safePool = Math.floor(budget / this.maxMemoryPerWorker);
    return Math.max(1, Math.min(this.HARD_MAX_WORKERS, safePool));
  }

  // oxlint-disable-next-line require-await
  public async initialize(tokenizerName: string): Promise<void> {
    if (this.isInitialized || this.isShuttingDown) return;
    if (this.calibrationPromise) return this.calibrationPromise;

    this.calibrationPromise = (async () => {
      const buffers = await getSerializedSharedBuffers(tokenizerName);
      this.initParams = { tokenizerName, ...buffers };

      const pathsToTry = [
        new URL("./worker/tokenworker.js", import.meta.url),
        new URL("../src/libs/vendoring/worker/tokenworker.js", import.meta.url),
      ];

      let validUrl: URL;
      try {
        validUrl = await Promise.any(
          // oxlint-disable-next-line require-await
          pathsToTry.map(async (p) => {
            if (fs.existsSync(p)) return p;
            throw new Error("Path not found");
          }),
        );
      } catch {
        throw new Error(
          "Could not find the tokenworker.js file in any expected location.",
        );
      }

      const pathStr = fileURLToPath(validUrl);

      if (pathStr.includes("~BUN") || pathStr.includes("$bunfs")) {
        const workerCode = fs.readFileSync(validUrl, "utf-8");
        this.workerFactory = () => new Worker(workerCode, { eval: true });
      } else {
        this.workerFactory = () => new Worker(validUrl);
      }

      const calibrationWorker = this.workerFactory();

      const reportedMemory = await new Promise<number>((resolve, reject) => {
        const onMsg = (data: WorkerResponse) => {
          if (
            typeof data === "object" &&
            "type" in data &&
            data.type === "ready"
          ) {
            calibrationWorker.off("message", onMsg);
            calibrationWorker.off("error", onErr);
            resolve(data.memoryUsage);
          }
        };

        const onErr = (err: Error) => {
          calibrationWorker.off("message", onMsg);
          calibrationWorker.off("error", onErr);
          calibrationWorker.terminate();
          reject(err);
        };

        calibrationWorker.on("message", onMsg);
        calibrationWorker.on("error", onErr);
        calibrationWorker.postMessage({ type: "init", ...this.initParams });
      });

      this.maxMemoryPerWorker = Math.max(reportedMemory, 50 * 1024 * 1024);

      this.attachWorkerHandlers(calibrationWorker);

      this.workers.push(calibrationWorker);
      this.idleWorkers.push(calibrationWorker);
      this.replenishPool();

      this.isInitialized = true;
      this.calibrationPromise = null;
    })();

    return this.calibrationPromise;
  }

  private createWorker(): Worker {
    if (!this.workerFactory) {
      throw new Error("Cannot spawn worker: Pool factory was not initialized.");
    }
    const worker = this.workerFactory();
    this.attachWorkerHandlers(worker);
    return worker;
  }

  private attachWorkerHandlers(worker: Worker) {
    worker.on("message", (data: WorkerResponse) => {
      if (!("jobId" in data)) return;

      const { jobId } = data;
      const callbacks = this.taskCallbacks.get(jobId);
      if (callbacks) {
        if ("results" in data) {
          if (data.memoryUsage) {
            this.maxMemoryPerWorker = Math.max(
              this.maxMemoryPerWorker,
              data.memoryUsage,
            );
          }
          callbacks.resolve(data.results);
        } else if ("error" in data) {
          const error = new Error(data.error.message);
          error.stack = data.error.stack;
          callbacks.reject(error);
        }
        this.taskCallbacks.delete(jobId);
        this.workerToJob.delete(worker);
        this.releaseWorker(worker);
      }
    });

    worker.on("exit", (code) => {
      if (code !== 0 && !this.isShuttingDown) {
        const { a } = x;
        this.maxMemoryPerWorker = Math.max(
          this.maxMemoryPerWorker * 1.5,
          128 * 1024 * 1024,
        );
        this.handleWorkerCrash(
          worker,
          createError(
            simpleTemplate(a.s.e.c.tc.workerCrashedCode, { Code: code }),
            { immediateExitCode: false },
          ),
        );
      } else {
        this.removeWorker(worker);
      }
    });

    worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleWorkerCrash(worker, error);
    });
  }

  private handleWorkerCrash(worker: Worker, err: Error) {
    const jobId = this.workerToJob.get(worker);
    if (jobId !== undefined) {
      const callbacks = this.taskCallbacks.get(jobId);
      if (callbacks) callbacks.reject(err);
      this.taskCallbacks.delete(jobId);
      this.workerToJob.delete(worker);
    }

    this.removeWorker(worker);
    this.enforcePoolSize();
    this.replenishPool();
  }

  private enforcePoolSize() {
    if (this.isShuttingDown) return;
    const target = this.calculateTargetPoolSize();

    while (this.workers.length > target && this.idleWorkers.length > 0) {
      const w = this.idleWorkers.pop()!;
      this.removeWorker(w);
    }
  }

  private replenishPool() {
    if (this.isShuttingDown || !this.initParams) return;
    const target = this.calculateTargetPoolSize();

    while (this.workers.length < target) {
      const worker = this.createWorker();
      worker.postMessage({ type: "init", ...this.initParams });
      this.workers.push(worker);
      this.idleWorkers.push(worker);

      if (this.requestQueue.length > 0) {
        const req = this.requestQueue.shift()!;
        const w = this.idleWorkers.pop()!;
        req.resolve(w);
      }
    }
  }

  private acquireWorker(): Promise<Worker> {
    if (this.isShuttingDown) {
      const { a } = x;
      return Promise.reject(
        createError(a.s.e.c.tc.poolShuttingDown, {
          immediateExitCode: false,
        }),
      );
    }

    this.enforcePoolSize();

    if (this.idleWorkers.length > 0) {
      return Promise.resolve(this.idleWorkers.pop()!);
    }
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject });
    });
  }

  private releaseWorker(worker: Worker) {
    if (this.isShuttingDown) {
      this.removeWorker(worker);
      return;
    }

    const targetPoolSize = this.calculateTargetPoolSize();

    if (this.workers.length > targetPoolSize) {
      this.removeWorker(worker);
      this.enforcePoolSize();
      return;
    }

    if (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;
      request.resolve(worker);
    } else {
      this.idleWorkers.push(worker);
    }
  }

  private removeWorker(worker: Worker) {
    void worker.terminate();
    this.workers = this.workers.filter((w) => w !== worker);
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
  }

  public async runJob(payload: WorkerPayload): Promise<number[]> {
    const worker = await this.acquireWorker();
    const jobId = this.nextJobId++;

    this.workerToJob.set(worker, jobId);

    const jobPromise = new Promise<number[]>((resolve, reject) => {
      this.taskCallbacks.set(jobId, { resolve, reject });
    });

    worker.postMessage({ ...payload, jobId, type: "count" });
    return jobPromise;
  }

  public shutdown() {
    this.isShuttingDown = true;
    const { a } = x;
    const shutdownErr = createError(a.s.e.c.tc.poolShuttingDown, {
      immediateExitCode: false,
    });
    for (const request of this.requestQueue) request.reject(shutdownErr);
    this.requestQueue = [];
    this.taskCallbacks.clear();
    this.workerToJob.clear();
    for (const worker of this.workers) void worker.terminate();
    this.workers = [];
    this.idleWorkers = [];
    this.isInitialized = false;
    // @ts-expect-error cleanup
    TokenWorkerPool.instance = undefined;
  }
}

export async function countTokensInParallel(
  tokenizerName: string,
  inputs: ParallelCountInput[],
  options: { numWorkers?: number } = {},
): Promise<number[]> {
  if (tokenizerName === "dummy") {
    return Promise.resolve(
      inputs.map((input) => {
        const { text, text_pair, options: tokOpts } = input;

        const countApproximateTokens = (
          str: string | null | undefined,
        ): number => {
          if (!str) return 0;
          const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g;
          const cjkMatches = str.match(cjkRegex) || [];
          const cjkTokens = cjkMatches.length * 1.5;

          const emojiRegex = /[\p{Emoji}\p{Extended_Pictographic}]/gu;
          const emojiMatches = str.match(emojiRegex) || [];
          const emojiTokens = emojiMatches.length * 2;

          const remainingText = str
            .replace(cjkRegex, "")
            .replace(emojiRegex, "");
          const otherTokens = remainingText.length / 4;

          return Math.ceil(cjkTokens + emojiTokens + otherTokens);
        };

        let tokenCount = countApproximateTokens(text);
        if (text_pair) {
          tokenCount += countApproximateTokens(text_pair);
          tokenCount += 1;
        }
        if (tokOpts?.add_special_tokens) {
          tokenCount += 3;
        }
        return tokenCount;
      }),
    );
  }

  if (inputs.length === 0) return [];

  const pool = TokenWorkerPool.getInstance();
  await pool.initialize(tokenizerName);

  const { sharedTokenizerBuffer, sharedConfigBuffer } =
    await getSerializedSharedBuffers(tokenizerName);

  const currentSafePoolSize = pool.currentTargetPoolSize;

  const maxWorkers = options.numWorkers
    ? Math.min(options.numWorkers, currentSafePoolSize)
    : currentSafePoolSize;

  const activeWorkers = Math.min(maxWorkers, inputs.length);

  const MAX_CHUNK_SIZE = 10000;
  const baseChunkSize = Math.ceil(inputs.length / activeWorkers);
  const chunkSize = Math.min(baseChunkSize, MAX_CHUNK_SIZE);

  const chunks = [];
  for (let i = 0; i < inputs.length; i += chunkSize) {
    chunks.push(inputs.slice(i, i + chunkSize));
  }

  const workerPromises = chunks.map(async (chunk) => {
    let retries = 2;
    while (true) {
      try {
        return await pool.runJob({
          tokenizerName,
          sharedTokenizerBuffer,
          sharedConfigBuffer,
          inputs: chunk,
        });
      } catch (err) {
        if (retries <= 0) throw err;
        retries--;
        errlog(
          { level: "warn" },
          simpleTemplate(x.a.s.m.c.tc.workerOomRetry, {
            Retries: retries,
          }),
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  });

  const results = await Promise.all(workerPromises);
  return results.flat();
}

export async function countTokens(
  tokenizerName: string,
  textToTokenize: string,
  options: { text_pair?: string | null; add_special_tokens?: boolean } = {},
): Promise<number> {
  const input: ParallelCountInput = {
    text: textToTokenize,
    text_pair: options.text_pair,
    options: { add_special_tokens: options.add_special_tokens },
  };

  const results = await countTokensInParallel(tokenizerName, [input], {
    numWorkers: 1,
  });
  return results[0] ?? 0;
}

export function shutdownTokenCounter() {
  if (TokenWorkerPool["instance"]) {
    TokenWorkerPool.getInstance().shutdown();
  }
}
