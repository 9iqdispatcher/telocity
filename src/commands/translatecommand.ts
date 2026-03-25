import type {
  Command,
  LLMConfigurableProps,
  LLMDependencies,
  PromptParam,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  exitOne,
  generateHelpText,
  isNodeError,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  buildTranslationInstructions,
  dummyDependencies,
  getDefaultModelParam,
  getPresetHelpText,
  LLMBATCHERUI,
  resolveModelConfig,
  stripGarbageNewLines,
  resolveModelParam,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class TranslateCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return {
      ChunkSize: getDefaultModelParam("chunkSize"),
      BatchSize: getDefaultModelParam("batchSize"),
      Parallel: getDefaultModelParam("parallel"),
      Delay: getDefaultModelParam("delay"),
      RetryDelay: getDefaultModelParam("retryDelay"),
      SourceLanguage: appConfig.SOURCE_LANGUAGE,
      TargetLanguage: appConfig.TARGET_LANGUAGE,
      DefaultModel: appConfig.DEFAULT_MODEL,
    };
  }
  static get options() {
    return {
      chunksize: {
        type: "string",
        short: "c",
      },
      batchsize: {
        type: "string",
        short: "b",
      },
      parallel: {
        type: "string",
      },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      source: {
        type: "string",
        short: "s",
        default: appConfig.SOURCE_LANGUAGE,
      },
      target: {
        type: "string",
        short: "t",
        default: appConfig.TARGET_LANGUAGE,
      },
      context: { type: "string", short: "i", default: "" },
      url: { type: "string", short: "u" },
      apikey: { type: "string", short: "k" },
      wait: { type: "string" },
      retrywait: { type: "string" },
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
      ...(this.constructor as typeof TranslateCommand).options,
      ...internalOptions,
    };
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: optionsForParser,
      allowPositionals: (this.constructor as typeof TranslateCommand)
        .allowPositionals,
      strict: true,
    });

    const translateHelp = () => {
      const helpText = generateHelpText(
        a.s.help.commands.tr,
        (this.constructor as typeof TranslateCommand).options,
        {
          ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
          ...TranslateCommand.helpReplacements,
        },
      );
      log(helpText);
    };

    if (argValues.help) {
      translateHelp();
      return 0;
    }

    if (!positionals[1] || !positionals[2]) {
      exitOne();
      translateHelp();
      throw createError(a.s.e.lllm.sourceTargetRequired, {
        code: "SOURCE_TARGET_REQUIRED",
      });
    }

    const sourcePath = positionals[1];
    const targetPath = positionals[2];
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

    const sourceLang = argValues.source;
    const targetLang = argValues.target;

    const usePreFlag = defPrep[0];
    const useSystemFlag = defSys[0];
    const roletag = defSys[2] || "system";
    const roletag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];
    let prependPromptFinal: PromptParam = EMPTY_FIELD[0];

    if (useSystemFlag) {
      const sysTemplate = defSys[1];
      const systemContent = buildTranslationInstructions(
        sysTemplate,
        sourceLang,
        targetLang,
      );
      sysPromptFinal = [true, systemContent, roletag, false];
    }

    let contextContent = "";
    if (argValues.context && argValues.context.trim() !== "") {
      contextContent = stripGarbageNewLines(argValues.context.trim()) + "\n\n";
    }

    let finalUserContent;
    if (usePreFlag) {
      const prepTemplate = defPrep[1];
      let processedPrep = buildTranslationInstructions(
        prepTemplate,
        sourceLang,
        targetLang,
      );

      if (processedPrep.includes("{{ .ContextualInformation }}")) {
        processedPrep = simpleTemplate(processedPrep, {
          ContextualInformation: contextContent,
        });
        finalUserContent = processedPrep;
      } else {
        finalUserContent = [processedPrep, contextContent]
          .filter(Boolean)
          .join("\n\n");
      }
    } else {
      finalUserContent = contextContent;
    }

    if (finalUserContent) {
      prependPromptFinal = [true, finalUserContent, roletag2, false];
    }

    let prefillPromptFinal: PromptParam = EMPTY_FIELD[1];

    if (defPrefill[0]) {
      const prefillTemplate = defPrefill[1];
      const processedPrefill = buildTranslationInstructions(
        prefillTemplate,
        sourceLang,
        targetLang,
      );

      prefillPromptFinal = [true, processedPrefill];
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

      chunkSize: resolveModelParam(
        argValues.chunksize,
        llmModelParams.chunkSize,
        appConfig.CHUNK_SIZE,
      ),
      batchSize: resolveModelParam(
        argValues.batchsize,
        llmModelParams.batchSize,
        appConfig.BATCH_SIZE,
      ),
      parallel: resolveModelParam(
        argValues.parallel,
        llmModelParams.parallel,
        appConfig.PARALLEL,
      ),
      delay: resolveModelParam(
        argValues.wait ? String(+argValues.wait * 1000) : undefined,
        llmModelParams.delay,
        appConfig.DELAY,
      ),
      retryDelay: resolveModelParam(
        argValues.retrywait ? String(+argValues.retrywait * 1000) : undefined,
        llmModelParams.retryDelay,
        appConfig.RETRY_DELAY,
      ),

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

    const initArgs: [LLMConfigurableProps, string, string, LLMDependencies?] = [
      options,
      sourcePath,
      targetPath,
    ];
    if (a.DEBUG_MODE) {
      initArgs.push(dummyDependencies);
    }

    try {
      const llm = await LLMBATCHERUI.init(...initArgs);
      a.activeJob = llm;
      await llm.execute();
    } catch (err) {
      if (isNodeError(err) && err.code === "PROCESSING_ALREADY_COMPLETE") {
        process.exitCode = 0;
        if (isNodeError(err.cause)) {
          log(err.cause.message);
        }
      } else {
        throw err;
      }
    } finally {
      a.activeJob = null;
    }
    return 0;
  }
}
