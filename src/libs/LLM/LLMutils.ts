import type {
  BackendStrategy,
  ChatCompletionsPayload,
  ConfigModelVariant,
  LanguageStrings,
  LLMConfigurableProps,
  LLMDependencies,
  MappableParamKey,
  Message,
  ModelConfig,
  ParamConfigs,
  ParsedStreamChunk,
  StrategyContext,
} from "../types/index.ts";

import {
  config as appConfig,
  createError,
  formatAlignedList,
  log,
  simpleTemplate,
  x,
} from "../core/index.ts";
import { LLM } from "./LLM.ts";

export function segmentText(text: string, chunkSize: number): string[] {
  const lines = text.split("\n");
  return Array.from({ length: Math.ceil(lines.length / chunkSize) }, (_, i) => {
    const start = i * chunkSize;
    const end = start + chunkSize;
    return lines.slice(start, end).join("\n");
  });
}

export function calcAvgLineLength(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  if (!lines.length) return 0;
  const segmenter = x.a.segmenter;
  const totalGraphemes = lines.reduce((sum, line) => {
    const graphemeCount = [...segmenter.segment(line)].length;
    return sum + graphemeCount;
  }, 0);
  return Math.round(totalGraphemes / lines.length);
}

export function calcAvgLineLengthBytes(text: string): number {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (!lines.length) return 0;
  const totalUTF8Bytes = lines.reduce((sum, line) => {
    const byteLength = Buffer.byteLength(line, "utf8");
    return sum + byteLength;
  }, 0);
  return Math.round(totalUTF8Bytes / lines.length);
}

export function stripGarbageNewLines(
  text: string | string[],
  stripEmpty = false,
): string {
  if (!Array.isArray(text) && typeof text !== "string") {
    const err = new TypeError(x.a.s.e.lllm.stripNewLinesTypeError);
    throw err;
  }

  const lines = Array.isArray(text) ? text : text.split(/\r\n|\r|\n/);

  const result = lines.reduce((acc: string[], line) => {
    const cleaned = line.replace(/\u2028|\u2029/g, "");

    if (stripEmpty && cleaned.trim() === "") {
      return acc;
    }

    acc.push(cleaned);
    return acc;
  }, []);

  if (stripEmpty) {
    while (result.length && result[0]?.trim() === "") result.shift();
    while (result.length && result[result.length - 1]?.trim() === "") {
      result.pop();
    }
  }

  return result.join("\n");
}

export function stripMarkdownFormatting(text: string): string {
  return (
    text
      // 1. Bold-Italics: ***text*** or ___text___
      .replace(/(\*\*\*|___)(?!\s)(.+?)(?<!\s)\1/g, "$2")
      // 2. Bold: **text** or __text__
      .replace(/(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g, "$2")
      // 3. Italics: *text* or _text_
      .replace(/(\*|_)(?!\s)(.+?)(?<!\s)\1/g, "$2")
  );
}

export function resolveModelConfig(
  paramsKey: string,
  useReasoning: boolean,
): ConfigModelVariant {
  const { a } = x;
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

  let activeConfig: ConfigModelVariant;

  switch (modelConfig.reasoningType) {
    case "reason_and_instruct":
      activeConfig = useReasoning
        ? modelConfig.reasoning
        : modelConfig.instruct;
      break;
    case "instruct_only":
      activeConfig = modelConfig.default;
      if (useReasoning) {
        log(
          simpleTemplate(a.s.e.lllm.reasoningNotSupported, {
            Model: paramsKey,
          }),
        );
      }
      break;
    case "reason_only":
      activeConfig = modelConfig.default;
      break;
    default:
      throw createError(
        simpleTemplate(a.s.e.lllm.invalidReasoningType, {
          Model: paramsKey,
          // @ts-expect-error - purely for error reporting
          Type: String(modelConfig.reasoningType),
        }),
        { code: "INVALID_REASONING_TYPE" },
      );
  }

  return activeConfig;
}

class DummyStrategy implements BackendStrategy {
  public readonly supportedParams: ReadonlyArray<MappableParamKey> = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "seed",
    "reasoning_effort",
    "chat_template_kwargs",
    "enable_thinking",
  ];

  buildPayload(
    messages: Message[],
    ctx: StrategyContext,
  ): ChatCompletionsPayload {
    return {
      messages,
      stream: true,
      model: "dummy-model",
      ...ctx.commonParams,
      _isDummyStrategyFlag: true,
    } as unknown as ChatCompletionsPayload;
  }

  parseChunk(chunk: ParsedStreamChunk, _ctx: StrategyContext) {
    return [{ text: chunk.text || "", kind: "delta" as const }];
  }
}

export const dummyDependencies: LLMDependencies = {
  strategy: new DummyStrategy(),
  llmcall: async function (
    this: LLM,
    messages: Message[],
    options?: {
      verbose?: boolean | ((chunk: string) => Promise<void>);
      overrides?: Partial<LLMConfigurableProps>;
      signal?: AbortSignal;
    },
  ): Promise<string> {
    const llmInstance = this as unknown as LLMConfigurableProps & LLM;

    const ctx = llmInstance.getStrategyContext(options?.overrides);
    const payload = llmInstance.strategy.buildPayload(messages, ctx);

    function* dummyStream(): Generator<string, void, unknown> {
      const summaryLines = [
        "--- Dummy LLM Call (Debug Mode) ---",
        `Timestamp: ${new Date().toISOString()}`,
        `URL: ${llmInstance.url ?? "N/A"}`,
        `API Key: ${llmInstance.apiKey ? "[PRESENT]" : "[NOT PRESENT]"}`,
        `Pre-call Delay: ${String(llmInstance.delay ?? "N/A")} ms`,
        "--- Final Payload (From Injected DummyStrategy) ---",
        JSON.stringify(payload, null, 2),
        "\n--- End Dummy Call ---",
      ];

      for (const line of summaryLines) {
        yield line + "\n";
        //await new Promise((resolve) => setTimeout(resolve, 666));
      }
    }

    const { verbose = false } = options ?? {};
    let result = "";

    for (const chunk of dummyStream()) {
      if (typeof verbose === "function") {
        await verbose(chunk);
      } else if (verbose) {
        process.stdout.write(chunk);
      }
      result += chunk;
    }

    return Promise.resolve(result);
  },
};

type PathString<T> = {
  [K in keyof T & string]: T[K] extends object
    ? `${K}` | `${K}.${PathString<T[K]>}`
    : `${K}`;
}[keyof T & string];

export function resolveStringKey<T>(
  obj: T,
  path: PathString<T>,
): string | undefined {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in acc) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj) as string | undefined;
}

function processPresets(
  configs: ParamConfigs,
  processor: (modelConfig: ModelConfig) => string | null,
): string {
  const items = Object.entries(configs)
    .map(([key, modelConfig]) => {
      const description = processor(modelConfig);
      if (description !== null) {
        return { key, description };
      }
      return null;
    })
    .filter(
      (item): item is { key: string; description: string } => item !== null,
    );

  return formatAlignedList(items, { listIndentWidth: 2 });
}

export function getPresetHelpText(configs: ParamConfigs): string {
  const { a } = x;

  return processPresets(configs, (modelConfig) => {
    const metadata = modelConfig.metadata;
    const helptextKey = metadata?.helptext_key;
    const display = metadata?.display;

    if (!display) {
      return null;
    }

    if (helptextKey) {
      const startsWithModels = helptextKey.startsWith("models.");
      const fullPath = `m.c.${helptextKey}`;
      const resolvedValue = resolveStringKey(
        a.s,
        fullPath as PathString<LanguageStrings>,
      );

      if (startsWithModels) {
        return resolvedValue ?? a.s.m.c.models.noHelp;
      }

      if (resolvedValue !== undefined && resolvedValue !== null) {
        return resolvedValue;
      }

      return helptextKey;
    }

    return a.s.m.c.models.noHelp;
  });
}

export function getThinkTags(configs: ParamConfigs): string {
  const { a } = x;
  return processPresets(configs, (modelConfig) => {
    const stripTags = modelConfig.metadata?.stripTags;
    if (stripTags?.start && stripTags?.end) {
      return `${a.s.m.lllm.openingTag}: '${stripTags.start}' ${a.s.m.lllm.closingTag}: '${stripTags.end}'`;
    }
    return null;
  });
}

export function buildTranslationInstructions(
  baseTemplate: string,
  sourceLanguage: string,
  targetLanguage: string,
) {
  return baseTemplate
    .replace(/\{\{\s*\.LanguageSource\s*\}\}/g, sourceLanguage)
    .replace(/\{\{\s*\.LanguageTarget\s*\}\}/g, targetLanguage);
}

export function getDefaultModelParam(
  param: "chunkSize" | "batchSize" | "parallel" | "delay" | "retryDelay",
): string {
  const fallbacks = {
    chunkSize: appConfig.CHUNK_SIZE,
    batchSize: appConfig.BATCH_SIZE,
    parallel: appConfig.PARALLEL,
    delay: appConfig.DELAY,
    retryDelay: appConfig.RETRY_DELAY,
  };

  const modelConfig = appConfig.PARAM_CONFIGS[appConfig.DEFAULT_MODEL];
  let val: number | undefined;

  if (modelConfig) {
    const activeVariant =
      modelConfig.reasoningType === "reason_and_instruct"
        ? modelConfig.instruct
        : modelConfig.default;

    val = activeVariant.model[param];
  }

  const result = val !== undefined && val !== null ? val : fallbacks[param];

  if (param === "delay" || param === "retryDelay") {
    return String(result / 1000);
  }

  return String(result);
}

export function resolveModelParam(
  cliValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
): number {
  if (cliValue !== undefined) {
    return +cliValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}
