import { readFile, writeFile } from "node:fs/promises";

import type {
  Command,
  LLMConfigurableProps,
  LLMDependencies,
  PromptParam,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEexistError,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  readStdin,
  red,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  buildImageContent,
  TerminalStreamer,
  dummyDependencies,
  getPresetHelpText,
  LLM,
  resolveModelConfig,
  stripGarbageNewLines,
  resolveModelParam,
  validateFiles,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class OneShotCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get defaultChunkSize() {
    return 200000;
  }
  static get defaultBatchSize() {
    return 1;
  }
  static get defaultParallel() {
    return 1;
  }
  static get helpReplacements() {
    return {
      DefaultModel: appConfig.DEFAULT_MODEL,
      ChunkSize: this.defaultChunkSize.toString(),
      BatchSize: this.defaultBatchSize.toString(),
    };
  }
  static get options() {
    return {
      file: { type: "string", short: "i" },
      outfile: { type: "string", short: "o" },
      image: { type: "string", short: "I" },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      url: { type: "string", short: "u" },
      apikey: { type: "string", short: "k" },
      reason: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const internalOptions = {
      debug: { type: "boolean", short: "d" },
    } as const;
    const optionsForParser = {
      ...(this.constructor as typeof OneShotCommand).options,
      ...internalOptions,
    };
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: optionsForParser,
      allowPositionals: (this.constructor as typeof OneShotCommand)
        .allowPositionals,
      strict: true,
    });

    const oneshotHelp = () => {
      const replacements = {
        ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
        ...OneShotCommand.helpReplacements,
      };
      const helpText = generateHelpText(
        a.s.help.commands.os,
        (this.constructor as typeof OneShotCommand).options,
        replacements,
      );
      log(helpText);
    };

    if (argValues.help) {
      oneshotHelp();
      return 0;
    }

    const imageURIs = await buildImageContent(argValues.image);

    let text = "";

    if (argValues.file) {
      const fpath = argValues.file;
      try {
        const rawFileContent = await readFile(fpath, "utf-8");
        await validateFiles(fpath);
        text = stripGarbageNewLines(rawFileContent);
      } catch (err) {
        if (isEnoentError(err)) {
          throw createError(
            simpleTemplate(a.s.e.lllm.fileNotFound, { FilePath: fpath }),
            {
              code: "SOURCE_FILE_NOT_FOUND",
              cause: err,
            },
          );
        }
        throw err;
      }
    } else if (a.isInteractive && !process.stdin.isTTY) {
      text = stripGarbageNewLines(await readStdin());
    }

    if (!positionals[1] && !text) {
      exitOne();
      oneshotHelp();
      errlog(red(a.s.e.lllm.promptMissing));
      return 1;
    }

    const positionalPrompt = stripGarbageNewLines(positionals[1] ?? "");
    const combinedContent = [positionalPrompt, text]
      .filter(Boolean)
      .join("\n\n");

    let fullUserPrompt = combinedContent;
    if (appConfig.TERMINAL_PREPEND && combinedContent) {
      fullUserPrompt = `${appConfig.TERMINAL_PREPEND}${combinedContent}`;
    }

    const paramsKey = argValues.params;
    const modelConfig = appConfig.PARAM_CONFIGS[paramsKey];
    if (!modelConfig) {
      throw createError(
        simpleTemplate(a.s.e.lllm.undefinedParam, {
          ParamKey: paramsKey,
        }),
        {
          code: "UNDEFINED_PARAM",
        },
      );
    }

    const useReasoning = !!argValues.reason;
    const activeConfig = resolveModelConfig(paramsKey, useReasoning);

    const llmModelParams = { ...activeConfig.model };

    const promptSettings = activeConfig.prompt || {};
    const defSys = promptSettings.defSys || EMPTY_FIELD[0];
    const defPrep = promptSettings.defPrep || EMPTY_FIELD[0];
    const defPrefill = promptSettings.defPrefill || EMPTY_FIELD[1];

    const roletag = defSys[2] || "system";
    const roletag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];

    const useDefaultSystemPrompt = defSys.at(-1);

    if (useDefaultSystemPrompt) {
      sysPromptFinal = [true, defSys[1], roletag, true];
    }

    const prependPromptFinal: PromptParam = [
      true,
      fullUserPrompt,
      roletag2,
      false,
    ];

    let prefillPromptFinal: PromptParam = EMPTY_FIELD[1];

    if (defPrefill[0]) {
      prefillPromptFinal = defPrefill;
    }

    const hasInstructions =
      (sysPromptFinal[0] && sysPromptFinal[1].trim() !== "") ||
      (prependPromptFinal[0] && prependPromptFinal[1].trim() !== "") ||
      (prefillPromptFinal[0] && prefillPromptFinal[1].trim() !== "");

    if (!hasInstructions) {
      throw createError(a.s.e.lllm.promptMissing, {
        code: "PROMPT_MISSING",
      });
    }

    const options: LLMConfigurableProps = {
      ...llmModelParams,
      // No chunking or parallelism for oneshot, so never use the defaults
      // from the presets json, only hardcoded values.
      chunkSize: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultChunkSize,
      ),
      batchSize: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultBatchSize,
      ),
      parallel: resolveModelParam(
        undefined,
        undefined,
        OneShotCommand.defaultParallel,
      ),
      delay: resolveModelParam(
        undefined,
        llmModelParams.delay,
        appConfig.DELAY,
      ),
      retryDelay: resolveModelParam(
        undefined,
        llmModelParams.retryDelay,
        appConfig.RETRY_DELAY,
      ),

      keepAlive: false,

      apiKey:
        argValues.apikey ??
        llmModelParams.apiKey ??
        process.env["TELOCITYKEY"] ??
        "",
      systemPrompt: sysPromptFinal,
      prependPrompt: prependPromptFinal,
      prefill: prefillPromptFinal,
      url: argValues.url || llmModelParams.url || appConfig.URL,
      model: argValues.model
        ? [true, argValues.model]
        : llmModelParams.model || [false, ""],
    };

    if (Array.isArray(imageURIs) && imageURIs.length > 0) {
      options.images = imageURIs;
    }

    const initArgs: [LLMConfigurableProps, LLMDependencies?] = [options];
    if (a.DEBUG_MODE) {
      initArgs.push(dummyDependencies);
    }

    const llm = new LLM(...initArgs);
    const messages = llm.newPrompt("");

    const targetFile = argValues.outfile || positionals[2];
    let responseText;

    try {
      a.activeJob = llm;

      if (targetFile) {
        responseText = stripGarbageNewLines(
          await llm.completion(messages, { verbose: false }),
        );

        try {
          await writeFile(targetFile, responseText, { flag: "wx" });
        } catch (err) {
          if (isEexistError(err)) {
            throw createError(
              simpleTemplate(a.s.e.lllm.targetFileExists, {
                TargetPath: targetFile,
              }),
              { code: "TARGET_EXISTS" },
            );
          }
          throw err;
        }
      } else {
        if (process.stdout.isTTY) {
          const streamer = new TerminalStreamer(
            a.TERMINAL_WIDTH,
            async (chunk) => {
              await new Promise<void>((resolve) => {
                if (process.stdout.write(chunk)) resolve();
                else process.stdout.once("drain", resolve);
              });
            },
            !a.NO_MARKDOWN,
          );

          responseText = await llm.completion(messages, {
            verbose: async (chunk) => {
              await streamer.process(chunk);
            },
          });

          await streamer.flush();
        } else {
          responseText = stripGarbageNewLines(
            await llm.completion(messages, { verbose: false }),
          );
          log(responseText);
        }
      }

      if (a.DEBUG_MODE && typeof responseText === "string") {
        log(responseText);
      }
    } finally {
      a.activeJob = null;
    }

    return 0;
  }
}
