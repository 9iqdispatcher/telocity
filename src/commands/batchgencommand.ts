import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";

import type {
  Command,
  ConfigModelVariant,
  Message,
  ResponsesMessage,
} from "../libs/types/index.ts";

import {
  config as appConfig,
  createError,
  exitOne,
  generateHelpText,
  isEexistError,
  isEnoentError,
  isNodeError,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import {
  buildTranslationInstructions,
  getDefaultModelParam,
  getPresetHelpText,
  segmentText,
  resolveModelParam,
  stripGarbageNewLines,
} from "../libs/LLM/index.ts";
import { EMPTY_FIELD } from "../libs/types/index.ts";

function createChatCompletionsLine(
  custom_id: string,
  model: string,
  messages: Message[],
  opts: {
    temperature?: number;
    enable_thinking?: boolean /* Alibaba Cloud Model Studio */;
  },
): string {
  const body: {
    model: string;
    messages: Message[];
    temperature?: number;
    enable_thinking?: boolean /* Alibaba Cloud Model Studio */;
  } = {
    model,
    messages,
  };

  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  /* Alibaba Cloud Model Studio */
  if (opts.enable_thinking !== undefined) {
    body.enable_thinking = opts.enable_thinking;
  }

  const payload = {
    custom_id,
    method: "POST",
    url: "/v1/chat/completions",
    body,
  };
  return JSON.stringify(payload);
}

function createResponsesLine(
  custom_id: string,
  model: string,
  messages: Message[],
  opts: {
    temperature?: number;
  },
): string {
  let instructions: string | undefined;
  const userInputMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system" && typeof msg.content === "string") {
      instructions = (instructions ? instructions + "\n" : "") + msg.content;
    } else {
      userInputMessages.push(msg);
    }
  }

  const transformedInput: ResponsesMessage[] = userInputMessages.map((msg) => ({
    type: "message",
    role: msg.role,
    content: [
      {
        type: msg.role === "assistant" ? "output_text" : "input_text",
        text: msg.content as string,
      },
    ],
  }));

  const body: {
    model: string;
    input: ResponsesMessage[];
    instructions?: string;
    temperature?: number;
  } = {
    model,
    input: transformedInput,
  };

  if (instructions) {
    body.instructions = instructions;
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  const payload = {
    custom_id,
    method: "POST",
    url: "/v1/responses",
    body,
  };
  return JSON.stringify(payload);
}

export default class BatchGenCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get helpReplacements() {
    return {
      ChunkSize: getDefaultModelParam("chunkSize"),
      DefaultModel: appConfig.DEFAULT_MODEL,
      FormatsList: BatchGenCommand.availableFormats,
    };
  }
  static get options() {
    return {
      format: { type: "string", short: "f", default: "openai-chatcompletions" },
      chunksize: {
        type: "string",
        short: "c",
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
      reason: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
    } as const;
  }

  static get BACKENDS(): Readonly<{
    readonly [key: string]: {
      readonly display: string;
      readonly makeLine: (
        requestId: string,
        model: string,
        messages: Message[],
        opts: {
          temperature?: number;
          enable_thinking?: boolean;
        },
      ) => string;
    };
  }> {
    return {
      "openai-chatcompletions": {
        display: "OpenAI Chat Completions (/v1/chat/completions)",
        makeLine: (requestId, model, messages, opts) =>
          createChatCompletionsLine(requestId, model, messages, {
            temperature: opts.temperature,
            enable_thinking: opts.enable_thinking,
          }),
      },
      "openai-responses": {
        display: "OpenAI Responses (/v1/responses)",
        makeLine: (requestId, model, messages, opts) =>
          createResponsesLine(requestId, model, messages, {
            temperature: opts.temperature,
          }),
      },
    } as const;
  }

  private static get availableFormats() {
    return Object.keys(BatchGenCommand.BACKENDS).join(", ");
  }

  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const optionsForParser = (this.constructor as typeof BatchGenCommand)
      .options;
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: optionsForParser,
      allowPositionals: (this.constructor as typeof BatchGenCommand)
        .allowPositionals,
      strict: true,
    });

    const batchgenhelptext = () => {
      const helpText = generateHelpText(
        a.s.help.commands.bg,
        (this.constructor as typeof BatchGenCommand).options,
        {
          ModelParamList: getPresetHelpText(appConfig.PARAM_CONFIGS),
          ...BatchGenCommand.helpReplacements,
          P_NAME: a.P_NAME,
        },
      );
      log(helpText);
    };

    if (argValues.help) {
      batchgenhelptext();
      return 0;
    }

    const format = argValues.format.toLowerCase();

    if (!positionals[1] || !positionals[2]) {
      batchgenhelptext();
      exitOne();
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

    let activeConfig: ConfigModelVariant;
    const useReasoning = !!argValues.reason;

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
            Type: String(modelConfig),
          }),
          { code: "INVALID_REASONING_TYPE" },
        );
    }

    const backend = BatchGenCommand.BACKENDS[format];
    if (!backend) {
      throw createError(
        simpleTemplate(a.s.e.lllm.invalidFormat, {
          Format: argValues.format,
          Available: BatchGenCommand.availableFormats,
        }),
        { code: "INVALID_FORMAT" },
      );
    }

    const promptSettings = activeConfig.prompt || {};
    const defSys = promptSettings.defSys || EMPTY_FIELD[0];
    const defPrep = promptSettings.defPrep || EMPTY_FIELD[0];
    const sourceLang = argValues.source;
    const targetLang = argValues.target;

    const usePreFlag = defPrep[0];
    const useSystemFlag = defSys[0];
    const roleTag = defSys[2] || "system";
    const roleTag2 = defPrep[2] || "user";

    let systemContent: string | null = null;
    if (useSystemFlag) {
      const sysTemplate = defSys[1];
      systemContent = buildTranslationInstructions(
        sysTemplate,
        sourceLang,
        targetLang,
      );
    }

    let contextContent = "";
    if (argValues.context && argValues.context.trim() !== "") {
      contextContent = stripGarbageNewLines(argValues.context.trim()) + "\n\n";
    }

    let finalUserContentTemplate;
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
        finalUserContentTemplate = processedPrep;
      } else {
        finalUserContentTemplate = [processedPrep, contextContent]
          .filter(Boolean)
          .join("\n\n");
      }
    } else {
      finalUserContentTemplate = contextContent;
    }

    const hasInstructions =
      (systemContent && systemContent.trim() !== "") ||
      (finalUserContentTemplate && finalUserContentTemplate.trim() !== "");

    if (!hasInstructions) {
      throw createError(a.s.e.lllm.promptMissing, {
        code: "PROMPT_MISSING",
      });
    }

    const modelName =
      argValues.model ||
      (activeConfig.model.model?.[0] ? activeConfig.model.model[1] : "");

    const temperatureTuple = activeConfig.model.temperature;
    const temperature = temperatureTuple?.[0] ? temperatureTuple[1] : undefined;

    let enableThinking: boolean | undefined;
    if (paramsKey.toLowerCase().includes("qwen")) {
      if (activeConfig.model.enable_thinking?.[0]) {
        /* Alibaba Cloud Model Studio */
        enableThinking = activeConfig.model.enable_thinking[1];
      } else if (activeConfig.model.chat_template_kwargs?.[0]) {
        // llama.cpp
        const kwargs = activeConfig.model.chat_template_kwargs[1];
        if (kwargs && typeof kwargs.enable_thinking === "boolean") {
          enableThinking = kwargs.enable_thinking;
        }
      }
    }

    let sourceText: string;
    try {
      sourceText = await readFile(sourcePath, "utf-8");
    } catch (err) {
      if (isEnoentError(err)) {
        throw createError(
          simpleTemplate(a.s.e.lllm.fileNotFound, {
            FilePath: sourcePath,
          }),
          { code: "ENOENT", cause: err },
        );
      }
      throw err;
    }

    const normalizedText = stripGarbageNewLines(sourceText);

    const chunkSize = resolveModelParam(
      argValues.chunksize,
      activeConfig.model.chunkSize,
      appConfig.CHUNK_SIZE,
    );

    const textChunks = segmentText(normalizedText, chunkSize).filter(
      (chunk) => chunk.trim() !== "",
    );

    if (textChunks.length === 0) {
      log(a.s.m.lllm.sourceEmpty);
      return 0;
    }

    log(
      simpleTemplate(a.s.m.lllm.generatingRequests, {
        Count: textChunks.length,
      }),
    );

    const writer = createWriteStream(targetPath, {
      flags: "wx",
      encoding: "utf-8",
    });

    try {
      await new Promise<void>((resolve, reject) => {
        writer.once("open", () => resolve());
        writer.once("error", reject);
      });
    } catch (err) {
      if (isEexistError(err)) {
        throw createError(
          simpleTemplate(a.s.e.lllm.targetFileExists, {
            TargetPath: targetPath,
          }),
          { code: "TARGET_EXISTS", cause: err },
        );
      }
      throw err;
    }

    try {
      for (const [index, chunk] of textChunks.entries()) {
        const requestId = `request-${index + 1}`;
        let fullUserContent: string;

        if (finalUserContentTemplate.includes("{{ .TextToInject }}")) {
          fullUserContent = simpleTemplate(finalUserContentTemplate, {
            TextToInject: chunk,
          });
        } else {
          fullUserContent = `${finalUserContentTemplate}\n\n${chunk}`;
        }

        const messages: Message[] = [];
        if (systemContent) {
          messages.push({ role: roleTag, content: systemContent });
        }
        messages.push({ role: roleTag2, content: fullUserContent });

        const jsonlLine = backend.makeLine(requestId, modelName, messages, {
          temperature,
          enable_thinking: enableThinking,
        });

        if (!writer.write(jsonlLine + "\n")) {
          await once(writer, "drain");
        }
      }

      writer.end();
      await finished(writer);

      log(
        simpleTemplate(a.s.m.lllm.wroteEntries, {
          Count: textChunks.length,
          TargetPath: targetPath,
        }),
      );
    } catch (err) {
      writer.destroy();
      await unlink(targetPath).catch(() => {});
      if (isNodeError(err) && err.code === "TARGET_EXISTS") {
        throw err;
      }
      throw createError(a.s.e.lllm.jsonlGenError, { cause: err });
    }

    return 0;
  }
}
