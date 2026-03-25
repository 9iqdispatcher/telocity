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
  buildImageContent,
  dummyDependencies,
  getDefaultModelParam,
  getPresetHelpText,
  LLMBATCHERUI,
  resolveModelConfig,
  stripGarbageNewLines,
  resolveModelParam,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

export default class TransformCommand implements Command {
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
      ChunkSize: this.defaultChunkSize.toString(),
      BatchSize: this.defaultBatchSize.toString(),
      Parallel: this.defaultParallel.toString(),
      Delay: getDefaultModelParam("delay"),
      RetryDelay: getDefaultModelParam("retryDelay"),
      DefaultModel: appConfig.DEFAULT_MODEL,
    };
  }
  static get options() {
    return {
      chunksize: { type: "string", short: "c" },
      batchsize: { type: "string", short: "b" },
      parallel: { type: "string" },
      model: { type: "string", short: "m" },
      params: { type: "string", short: "p", default: appConfig.DEFAULT_MODEL },
      prompt: { type: "string", short: "i" },
      image: { type: "string", short: "I" },
      sysprompt: { type: "string", short: "s" },
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
      ...(this.constructor as typeof TransformCommand).options,
      ...internalOptions,
    };
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: optionsForParser,
      allowPositionals: (this.constructor as typeof TransformCommand)
        .allowPositionals,
      strict: true,
    });

    const transformHelp = () => {
      const helpText = generateHelpText(
        a.s.help.commands.tf,
        (this.constructor as typeof TransformCommand).options,
        {
          ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
          ...TransformCommand.helpReplacements,
        },
      );
      log(helpText);
    };

    if (argValues.help) {
      transformHelp();
      return 0;
    }

    const imageURIs = await buildImageContent(argValues.image);

    if (!positionals[1] || !positionals[2]) {
      exitOne();
      transformHelp();
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

    const roletag = defSys[2] || "system";
    const roletag2 = defPrep[2] || "user";

    let sysPromptFinal: PromptParam = EMPTY_FIELD[0];
    let prependPromptFinal: PromptParam;

    const useDefaultSystemPrompt = defSys.at(-1);
    const useDefaultPrepPrompt = defPrep.at(-1);

    if (argValues.sysprompt) {
      sysPromptFinal = [
        true,
        stripGarbageNewLines(argValues.sysprompt),
        roletag,
        false,
      ];
    } else if (useDefaultSystemPrompt) {
      sysPromptFinal = [true, defSys[1], roletag, true];
    }

    if (argValues.prompt) {
      prependPromptFinal = [
        true,
        stripGarbageNewLines(argValues.prompt) + "\n\n",
        roletag2,
        false,
      ];
    } else if (useDefaultPrepPrompt) {
      prependPromptFinal = [true, defPrep[1] + "\n\n", roletag2, true];
    } else {
      prependPromptFinal = [
        true,
        appConfig.DEFAULT_TF_PROMPT + "\n\n",
        roletag2,
        false,
      ];
    }

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
      // always override with either hardcoded or CLI values
      // batching is a special case, not the common use case, for this command
      // unlike the translation focused translation command where using
      // a chunked approach makes sense
      // if you need to batch with an arbitrary prompt, pass --chunksize
      // --batchsize and --parallel from the CLI rather tha relying on
      // json presets
      chunkSize: resolveModelParam(
        argValues.chunksize,
        undefined,
        TransformCommand.defaultChunkSize,
      ),
      batchSize: resolveModelParam(
        argValues.batchsize,
        undefined,
        TransformCommand.defaultBatchSize,
      ),
      parallel: resolveModelParam(
        argValues.parallel,
        undefined,
        TransformCommand.defaultParallel,
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

    if (Array.isArray(imageURIs) && imageURIs.length > 0) {
      options.images = imageURIs;
    }

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
