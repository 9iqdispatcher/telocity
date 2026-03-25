export type OutputTextPart = {
  type: "output_text";
  text: string;
};

export type ReasoningTextPart = {
  type: "reasoning_text";
  text: string;
};

export type OutputContentItem = OutputTextPart | ReasoningTextPart;

export type MessageOutputItem = {
  type: "message";
  id?: string;
  role?: "assistant";
  content: OutputTextPart[];
};

export type ReasoningOutputItem = {
  type: "reasoning";
  id?: string;
  summary?: { type: "summary_text"; text: string }[];
  encrypted_content?: string | null;
  content?: ReasoningTextPart[];
};

export type FunctionCallOutputItem = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type FunctionCallOutputResultItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type OutputItem =
  | MessageOutputItem
  | ReasoningOutputItem
  | FunctionCallOutputItem
  | FunctionCallOutputResultItem;

export type ParsedStreamChunk = {
  type?: string;
  delta?: string;
  text?: string;
  response?: {
    output?: OutputItem[];
  };
  output?: OutputItem[];
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string; // llama.cpp and deepseek APIs
    };
    message?: {
      content?: string;
      reasoning_content?: string; // llama.cpp and deepseek APIs
    };
  }>;
  item?: OutputItem;
};

export type RawStreamChunk = {
  // ChatCompletions
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string; // llama.cpp and deepseek APIs
    };
    message?: {
      content?: string;
      reasoning_content?: string; // llama.cpp and deepseek APIs
    };
  }[];
  // Responses API
  output?: {
    type?: "message" | "reasoning";
    content?: { type: "output_text"; text: string }[];
  }[];
};

export type ImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

export type TextContentPart = {
  type: "text";
  text: string;
};

export type MessageContent = string | (TextContentPart | ImageContentPart)[];

export interface Message {
  role: string;
  content: MessageContent;
  reasoning_content?: string;
  encrypted_reasoning?: string;
}

export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      image_url?: string;
      image_base64?: string;
    };

export interface ResponsesMessage {
  type: "message";
  role: string;
  content: ResponsesInputContentPart[];
}

export const VALID_REASONING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortValue =
  (typeof VALID_REASONING_EFFORT_VALUES)[number];

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}
export type ResponseFormat =
  | JsonSchemaResponseFormat
  | { type: "text" | "json_object" }
  | Record<string, unknown>;

export type ResponsesPayload = {
  input: ResponsesMessage[] | string;
  instructions?: string;
  model?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  seed?: number;
  tools?: unknown[];
  store?: boolean;
  include?: string[];
  reasoning?: {
    effort?: ReasoningEffortValue;
    summary?: "auto" | boolean;
  }; // official v1/responses API
  response_format?: ResponseFormat;
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gpt-oss
    enable_thinking?: boolean; // Qwen
    [key: string]: unknown;
  }; // llama.cpp
};

export type ChatCompletionsPayload = {
  messages: Message[];
  stream: boolean;
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  seed?: number;
  reasoning_effort?: ReasoningEffortValue; // official v1/chat/completions
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gpt-oss
    enable_thinking?: boolean; // Qwen
    [key: string]: unknown;
  }; // llama.cpp
  enable_thinking?: boolean; // Alibaba Cloud Model Studio
  response_format?: ResponseFormat;
};

export type CompletionsPayload = {
  prompt: string;
  stream: boolean;
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  seed?: number;
  reasoning_effort?: ReasoningEffortValue;
  chat_template_kwargs?: {
    reasoning_effort?: ReasoningEffortValue; // gpt-oss
    enable_thinking?: boolean; // Qwen
    [key: string]: unknown;
  };
};

export type ConfigParam<T> = readonly [enabled: boolean, value: T];

export type PromptParam =
  | ConfigParam<string>
  | readonly [
      enabled: boolean,
      value: string,
      role: string,
      another_flag: boolean,
    ];

export type StringParam = ConfigParam<string>;
export type NumberParam = ConfigParam<number>;

export interface LLMConfigurableProps {
  url?: string;
  apiKey?: string;
  delay?: number;
  retryDelay?: number;
  maxAttempts?: number;
  tempIncrement?: number;
  model?: StringParam;
  images?: string[];
  temperature?: NumberParam;
  top_p?: NumberParam;
  top_k?: NumberParam;
  presence_penalty?: NumberParam;
  seed?: NumberParam;
  hardTimeout?: number;
  idleTimeout?: number;
  reasoning_effort?: ConfigParam<ReasoningEffortValue>; // official v1/chat/completions
  chat_template_kwargs?: ConfigParam<{
    reasoning_effort: ReasoningEffortValue; // gpt-oss
    enable_thinking?: boolean; // Qwen
  }>;
  reasoning?: ConfigParam<{ effort: ReasoningEffortValue }>; // official v1/responses API
  include?: ConfigParam<string[]>; // v1/responses
  enable_thinking?: ConfigParam<boolean>; // Alibaba Cloud Model Studio
  response_format?: ConfigParam<ResponseFormat>;
  systemPrompt?: PromptParam;
  prependPrompt?: PromptParam;
  prefill?: PromptParam;
  lastIndex?: number;
  chunkSize: number;
  batchSize: number;
  parallel: number;
  keepAlive?: boolean;
  previousReasoning?: {
    encrypted?: string | null;
    unencrypted?: string | null;
    preferred?: string | null;
  };
}

export type MappableParamKey = Extract<
  keyof LLMConfigurableProps,
  keyof ChatCompletionsPayload | keyof ResponsesPayload
>;

export type MappableParamValue =
  | ChatCompletionsPayload[keyof ChatCompletionsPayload]
  | ResponsesPayload[keyof ResponsesPayload]
  | CompletionsPayload[keyof CompletionsPayload];

export type TerminationState = "none" | "requested" | "forceful";

export interface ProgressState extends LLMConfigurableProps {
  fileName: string;
  lastIndex: number;
}

interface ConfigMetadata {
  helptext_key?: string;
  stripTags?: { start: string; end: string };
  display?: boolean;
}

type ConfigModelParams = Pick<
  LLMConfigurableProps,
  | "chunkSize"
  | "batchSize"
  | "parallel"
  | "maxAttempts"
  | "tempIncrement"
  | "url"
  | "apiKey"
  | "delay"
  | "retryDelay"
  | "model"
  | "temperature"
  | "top_p"
  | "top_k"
  | "presence_penalty"
  | "seed"
  | "hardTimeout"
  | "idleTimeout"
  | "reasoning_effort" // official v1/chat/completions
  | "chat_template_kwargs" // llama.cpp
  | "reasoning" // official v1/responses
  | "include" // v1/responses
  | "enable_thinking" // Alibaba Cloud Model Studio
  | "response_format"
>;

export interface ConfigPrompt {
  defSys?: PromptParam;
  defPrep?: PromptParam;
  defPrefill?: PromptParam;
}

export interface ConfigModelVariant {
  prompt?: ConfigPrompt;
  model: Partial<ConfigModelParams>;
}

interface ModelConfigBase {
  reasoningType: "reason_and_instruct" | "instruct_only" | "reason_only";
  metadata: ConfigMetadata;
}

export interface InstructOnlyModelConfig extends ModelConfigBase {
  reasoningType: "instruct_only";
  default: ConfigModelVariant;
}

export interface ReasonOnlyModelConfig extends ModelConfigBase {
  reasoningType: "reason_only";
  default: ConfigModelVariant;
}

export interface ReasonAndInstructModelConfig extends ModelConfigBase {
  reasoningType: "reason_and_instruct";
  instruct: ConfigModelVariant;
  reasoning: ConfigModelVariant;
}

export type ModelConfig =
  | InstructOnlyModelConfig
  | ReasonOnlyModelConfig
  | ReasonAndInstructModelConfig;

export type ParamConfigs = Record<string, ModelConfig>;

export interface AppConfig {
  DEFAULT_MODEL: string;
  HARD_TIMEOUT: number;
  IDLE_TIMEOUT: number;
  CHUNK_SIZE: number;
  BATCH_SIZE: number;
  PARALLEL: number;
  URL: string;
  DELAY: number;
  RETRY_DELAY: number;
  SOURCE_LANGUAGE: string;
  TARGET_LANGUAGE: string;
  TERMINAL_PREPEND: string;
  DEFAULT_TF_PROMPT: string;
  TEMPLATES?: Record<string, string>;
  PARAM_CONFIGS: ParamConfigs;
}

export interface IReasoningTracker {
  encrypted: string | null;
  unencrypted: string | null;
  summary: string | null;

  processOutputItem(item: OutputItem): string;
  appendUnencrypted(delta: string): void;
}

export interface StrategyContext {
  commonParams: Record<string, unknown>;
  prefill?: PromptParam;
  previousReasoning?: {
    encrypted?: string | null;
    unencrypted?: string | null;
    preferred?: string | null;
  };
  reasoningTracker: IReasoningTracker;
}

export interface BackendStrategy {
  readonly supportedParams: ReadonlyArray<MappableParamKey>;
  buildPayload(
    messages: Message[],
    context: StrategyContext,
  ): ChatCompletionsPayload | ResponsesPayload | CompletionsPayload;

  parseChunk(
    chunk: ParsedStreamChunk,
    context: StrategyContext,
  ): Array<{ text: string; kind: "delta" | "output" | "conditional" }>;
}

export interface LLMDependencies {
  llmcall?: (
    messages: Message[],
    options?: {
      verbose?: boolean | ((chunk: string) => Promise<void>);
      overrides?: Partial<LLMConfigurableProps>;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
  strategy?: BackendStrategy;
}

export const EMPTY_FIELD: readonly [PromptParam, PromptParam] = Object.freeze([
  [false, "", "", false],
  [false, ""],
]);
