import { randomBytes } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { Command } from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isNodeError,
  log,
  customParseArgs as parseArgs,
  readStdin,
  red,
  runConcur,
  simpleTemplate,
  x,
  yellow,
} from "../libs/core/index.ts";
import { stripGarbageNewLines, validateFiles } from "../libs/LLM/index.ts";
import {
  countTokens,
  countTokensInParallel,
  shutdownTokenCounter,
} from "../libs/vendoring/index.ts";

interface TypeMap {
  string: string;
  boolean: boolean;
  number: number;
}

type TcCommandArgs = {
  [K in keyof typeof TcCommand.options]: TypeMap[(typeof TcCommand.options)[K]["type"]];
};

export default class TcCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return { DefaultModel: appConfig.DEFAULT_MODEL };
  }
  static get options() {
    return {
      chunksize: { type: "string", short: "c" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  static get MODELS_TO_DOWNLOAD(): Readonly<{
    readonly [key: string]: readonly string[];
  }> {
    return {
      qwen: [
        "https://huggingface.co/Qwen/Qwen3.5-35B-A3B/resolve/main/tokenizer.json",
        "https://huggingface.co/Qwen/Qwen3.5-35B-A3B/resolve/main/tokenizer_config.json",
      ],
    } as const;
  }

  private static get availableModels() {
    return Object.keys(TcCommand.MODELS_TO_DOWNLOAD).join(", ");
  }

  private async handleModelDownload(modelName: string): Promise<void> {
    const { a } = x;
    const modelUrls =
      TcCommand.MODELS_TO_DOWNLOAD[
        modelName as keyof typeof TcCommand.MODELS_TO_DOWNLOAD
      ];

    if (!modelUrls) {
      throw createError(
        simpleTemplate(a.s.e.c.tc.modelNotFoundForDownload, {
          ModelName: modelName,
        }) +
          `\n${simpleTemplate(a.s.m.c.tc.availableModelsForDownload, {
            AvailableModels: TcCommand.availableModels,
          })}`,
      );
    }

    const baseDir = path.join(a.STATE_DIR, "models");
    const [modelUrl, configUrl] = modelUrls;
    const modelDestPath = path.join(baseDir, `${modelName}.json`);
    const configDestPath = path.join(baseDir, `${modelName}_config.json`);

    try {
      await access(modelDestPath, fsConstants.F_OK);
      await access(configDestPath, fsConstants.F_OK);
      return;
    } catch {
      /* ignore */
    }

    log(
      simpleTemplate(a.s.m.c.tc.downloadingModelFiles, {
        ModelName: modelName,
      }),
    );

    try {
      await mkdir(baseDir, { recursive: true });

      log(
        simpleTemplate(a.s.m.c.tc.writingFilesTo, {
          StateDir: baseDir,
        }),
      );

      const HARD_TIMEOUT = 5 * 60 * 1000;

      const downloadAndSave = async (url: string, destPath: string) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HARD_TIMEOUT);

        const randomSuffix = randomBytes(4).toString("hex");
        const tmpPath = `${destPath}.${randomSuffix}.tmp`;

        try {
          const res = await fetch(url, { signal: controller.signal });

          if (!res.ok) {
            throw createError(
              simpleTemplate(a.s.e.c.tc.failedToDownload, {
                ModelUrl: url,
                Status: res.status,
                StatusText: res.statusText,
              }),
            );
          }
          if (!res.body) {
            throw createError(a.s.e.lllm.responseNull, {
              code: "NULL_RESPONSE_BODY",
            });
          }

          await pipeline(
            res.body as unknown as AsyncIterable<Uint8Array>,
            createWriteStream(tmpPath),
          );

          await rename(tmpPath, destPath);
        } catch (err) {
          try {
            await unlink(tmpPath);
          } catch {
            /* ignore */
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }
      };

      await runConcur(
        [
          () => downloadAndSave(modelUrl!, modelDestPath),
          () => downloadAndSave(configUrl!, configDestPath),
        ],
        { concurrency: 2 },
      );

      log(
        simpleTemplate(a.s.m.c.tc.downloadSuccess, {
          ModelName: modelName,
        }),
      );
      log(`- ${modelDestPath}`);
      log(`- ${configDestPath}`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw createError(a.s.e.lllm.hardTimeOut);
      } else if (isNodeError(err)) {
        throw createError(
          simpleTemplate(a.s.e.c.tc.modelDownloadError, {
            ErrorMessage: err.message,
          }),
        );
      }
      throw err;
    }
  }

  private chunkText(text: string, byteChunkSize: number): string[] {
    const chunks: string[] = [];
    const lines = text.split("\n");
    let currentChunk = "";
    let currentSize = 0;

    for (const line of lines) {
      const lineWithNewline = `${line}\n`;
      const lineSize = Buffer.byteLength(lineWithNewline);

      if (currentSize + lineSize > byteChunkSize && currentChunk !== "") {
        chunks.push(currentChunk);
        currentChunk = lineWithNewline;
        currentSize = lineSize;
      } else {
        currentChunk += lineWithNewline;
        currentSize += lineSize;
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  private async countTok(
    normalizedText: string,
    model: string,
    chunkSizeForLines: number,
  ) {
    const { a } = x;
    const specialTokensCount = await countTokens(model, "", {
      add_special_tokens: true,
    });

    const byteChunkSize = 750000;
    const chunks = this.chunkText(normalizedText, byteChunkSize);
    const inputs = chunks.map((chunk) => ({
      text: chunk,
      options: { add_special_tokens: false },
    }));

    const counts = await countTokensInParallel(model, inputs);
    const textOnlyTokenCount = counts.reduce((sum, count) => sum + count, 0);

    const tokenCount = textOnlyTokenCount + specialTokensCount;
    const lineCount = normalizedText.split("\n").length;

    const avgPerChunk =
      lineCount > 0
        ? (tokenCount / (lineCount / chunkSizeForLines)).toFixed(2)
        : "0.00";

    log(`${model}:`);
    log(`${a.s.m.c.tc.tc}`, yellow(tokenCount.toString()));
    log(
      simpleTemplate(a.s.m.c.tc.avgTc, {
        ChunkSize: chunkSizeForLines.toString(),
      }),
      yellow(avgPerChunk),
    );
  }

  async execute(argv: string[]): Promise<number> {
    try {
      const { a } = x;
      const { values: argValues, positionals } = parseArgs({
        args: argv,
        allowPositionals: (this.constructor as typeof TcCommand)
          .allowPositionals,
        strict: true,
        options: (this.constructor as typeof TcCommand).options,
      }) as { values: TcCommandArgs; positionals: string[] };

      const tcHelp = () => {
        const helpText = generateHelpText(
          a.s.help.commands.tc,
          (this.constructor as typeof TcCommand).options,
          {
            TokenParamList: TcCommand.availableModels,
            DefaultModel: appConfig.DEFAULT_MODEL,
          },
        );
        log(helpText);
      };

      if (argValues.help) {
        tcHelp();
        return 0;
      }

      let normalizedText: string;

      if (a.isInteractive && !process.stdin.isTTY) {
        const text = await readStdin();
        normalizedText = stripGarbageNewLines(text);
      } else {
        if (!positionals[1]) {
          exitOne();
          tcHelp();
          throw createError(a.s.e.lllm.sourceRequired, {
            code: "SOURCE_REQUIRED",
          });
        }

        const sourcePath = positionals[1];
        await validateFiles(sourcePath);

        const rawText = await readFile(sourcePath, "utf-8");
        normalizedText = stripGarbageNewLines(rawText);
      }

      const presetName = argValues.params;
      let resolvedTokenizer = presetName;

      if (!(resolvedTokenizer in TcCommand.MODELS_TO_DOWNLOAD)) {
        const lowerPreset = presetName.toLowerCase();
        const fallback = Object.keys(TcCommand.MODELS_TO_DOWNLOAD).find((t) =>
          lowerPreset.includes(t.toLowerCase()),
        );

        if (fallback) {
          resolvedTokenizer = fallback;
        } else {
          exitOne();
          tcHelp();
          errlog(
            red(
              simpleTemplate(a.s.e.c.tc.tokenizerDoesNotExist, {
                PresetName: presetName,
              }),
            ),
          );
          return 1;
        }
      }

      await this.handleModelDownload(resolvedTokenizer);

      let chunkSizeForLines: number | undefined;

      if (argValues.chunksize !== undefined) {
        chunkSizeForLines = Number(argValues.chunksize);
      } else {
        const modelConfig = appConfig.PARAM_CONFIGS[presetName];
        if (modelConfig) {
          const activeVariant =
            modelConfig.reasoningType === "reason_and_instruct"
              ? modelConfig.instruct
              : modelConfig.default;

          if (activeVariant?.model?.chunkSize !== undefined) {
            chunkSizeForLines = Number(activeVariant.model.chunkSize);
          }
        }

        if (chunkSizeForLines === undefined) {
          chunkSizeForLines = appConfig.CHUNK_SIZE;
        }
      }

      if (
        chunkSizeForLines === undefined ||
        isNaN(chunkSizeForLines) ||
        chunkSizeForLines <= 0
      ) {
        chunkSizeForLines = 1;
      }

      await this.countTok(normalizedText, resolvedTokenizer, chunkSizeForLines);

      return 0;
    } finally {
      shutdownTokenCounter();
    }
  }
}
