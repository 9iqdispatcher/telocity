#!/usr/bin/env bun

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";

import type { AppConfig } from "../src/libs/types/index.ts";

const VALID_REASONING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const definitions = {
  stringParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "string" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  numberParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  booleanParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "boolean" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  objectParam: {
    type: "array",
    items: [{ type: "boolean" }, { type: "object" }],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  responseFormatParam: {
    type: "array",
    items: [
      { type: "boolean" },
      {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              type: { enum: ["text", "json_object"] },
            },
            required: ["type"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { const: "json_schema" },
              json_schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  schema: { type: "object" },
                  strict: { type: "boolean" },
                },
                required: ["name", "schema"],
                additionalProperties: false,
              },
            },
            required: ["type", "json_schema"],
            additionalProperties: false,
          },
          {
            type: "object",
          },
        ],
      },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  reasoningEffortParam: {
    type: "array",
    items: [
      { type: "boolean" },
      { type: "string", enum: [...VALID_REASONING_EFFORT_VALUES] },
    ],
    minItems: 2,
    maxItems: 2,
    additionalItems: false,
  },
  promptParam: {
    oneOf: [
      {
        type: "array",
        items: [{ type: "boolean" }, { type: "string" }],
        minItems: 2,
        maxItems: 2,
        additionalItems: false,
      },
      {
        type: "array",
        items: [
          { type: "boolean" },
          { type: "string" },
          { type: "string" },
          { type: "boolean" },
        ],
        minItems: 4,
        maxItems: 4,
        additionalItems: false,
      },
    ],
  },
  configMetadata: {
    type: "object",
    properties: {
      helptext_key: { type: "string" },
      stripTags: {
        type: "object",
        properties: {
          start: { type: "string" },
          end: { type: "string" },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
      display: { type: "boolean" },
    },
    additionalProperties: false,
  },
  configModelParams: {
    type: "object",
    properties: {
      chunkSize: { type: "number", minimum: 1 },
      batchSize: { type: "number", minimum: 1 },
      parallel: { type: "number", minimum: 1 },
      url: { type: "string", format: "uri" },
      apiKey: { type: "string" },
      delay: { type: "number", minimum: 1 },
      retryDelay: { type: "number", minimum: 1 },
      maxAttempts: { type: "number", minimum: 1 },
      tempIncrement: { type: "number", minimum: 0 },
      hardTimeout: { type: "number", minimum: 0.1 },
      idleTimeout: { type: "number", minimum: 0.001 },

      model: { $ref: "#/definitions/stringParam" },
      temperature: { $ref: "#/definitions/numberParam" },
      top_p: { $ref: "#/definitions/numberParam" },
      top_k: { $ref: "#/definitions/numberParam" },
      presence_penalty: { $ref: "#/definitions/numberParam" },
      seed: { $ref: "#/definitions/numberParam" },

      reasoning_effort: { $ref: "#/definitions/reasoningEffortParam" },
      enable_thinking: { $ref: "#/definitions/booleanParam" },
      chat_template_kwargs: { $ref: "#/definitions/objectParam" },
      reasoning: { $ref: "#/definitions/objectParam" },
      response_format: { $ref: "#/definitions/responseFormatParam" },
    },
    additionalProperties: false,
  },
  configPrompt: {
    type: "object",
    properties: {
      defSys: { $ref: "#/definitions/promptParam" },
      defPrep: { $ref: "#/definitions/promptParam" },
      defPrefill: { $ref: "#/definitions/promptParam" },
    },
    minProperties: 1,
    additionalProperties: false,
  },
  configModelVariant: {
    type: "object",
    properties: {
      prompt: { $ref: "#/definitions/configPrompt" },
      model: { $ref: "#/definitions/configModelParams" },
    },
    required: ["model"],
    additionalProperties: false,
  },
  instructOnlyModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "instruct_only" },
      metadata: { $ref: "#/definitions/configMetadata" },
      default: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "default"],
  },
  reasonOnlyModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "reason_only" },
      metadata: { $ref: "#/definitions/configMetadata" },
      default: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "default"],
  },
  reasonAndInstructModelConfig: {
    type: "object",
    properties: {
      reasoningType: { const: "reason_and_instruct" },
      metadata: { $ref: "#/definitions/configMetadata" },
      instruct: { $ref: "#/definitions/configModelVariant" },
      reasoning: { $ref: "#/definitions/configModelVariant" },
    },
    required: ["reasoningType", "instruct", "reasoning"],
  },
} as const;

const appConfigSchema = {
  type: "object",
  properties: {
    DEFAULT_MODEL: { type: "string" },
    HARD_TIMEOUT: { type: "number", minimum: 0.1 },
    IDLE_TIMEOUT: { type: "number", minimum: 0.001 },
    CHUNK_SIZE: { type: "number", minimum: 1 },
    BATCH_SIZE: { type: "number", minimum: 1 },
    PARALLEL: { type: "number", minimum: 1 },
    URL: { type: "string", format: "uri" },
    DELAY: { type: "number", minimum: 1 },
    RETRY_DELAY: { type: "number", minimum: 1 },
    SOURCE_LANGUAGE: { type: "string" },
    TARGET_LANGUAGE: { type: "string" },
    TERMINAL_PREPEND: { type: "string" },
    DEFAULT_TF_PROMPT: { type: "string" },
    TEMPLATES: {
      type: "object",
      patternProperties: {
        "^.+$": { type: "string" },
      },
    },
    PARAM_CONFIGS: {
      type: "object",
      patternProperties: {
        "^.+$": {
          type: "object",
          oneOf: [
            { $ref: "#/definitions/instructOnlyModelConfig" },
            { $ref: "#/definitions/reasonOnlyModelConfig" },
            { $ref: "#/definitions/reasonAndInstructModelConfig" },
          ],
          discriminator: { propertyName: "reasoningType" },
        },
      },
      additionalProperties: false,
    },
  },
  required: [
    "DEFAULT_MODEL",
    "HARD_TIMEOUT",
    "IDLE_TIMEOUT",
    "CHUNK_SIZE",
    "BATCH_SIZE",
    "PARALLEL",
    "URL",
    "DELAY",
    "RETRY_DELAY",
    "SOURCE_LANGUAGE",
    "TARGET_LANGUAGE",
    "TERMINAL_PREPEND",
    "DEFAULT_TF_PROMPT",
    "TEMPLATES",
    "PARAM_CONFIGS",
  ],
  additionalProperties: false,
  definitions,
} as const;

const ajv = new Ajv.default({
  allErrors: true,
  strict: true,
  discriminator: true,
});
addFormats.default(ajv);

const validate = ajv.compile<AppConfig>(appConfigSchema);

type ValidationResult =
  | { isValid: true; data: AppConfig }
  | { isValid: false; errors: typeof validate.errors };

function isAppConfig(data: unknown): data is AppConfig {
  return validate(data);
}

export function validateConfig(data: unknown): ValidationResult {
  if (isAppConfig(data)) {
    return {
      isValid: true,
      data,
    };
  }
  return {
    isValid: false,
    errors: validate.errors,
  };
}

async function main() {
  console.log("Attempting to validate 'config.json'...");

  try {
    const configPath = "./data/config/template.config.json";
    const fileContent = await readFile(configPath, "utf-8");
    const configData: unknown = JSON.parse(fileContent);

    const result = validateConfig(configData);

    if (result.isValid) {
      console.log("\nConfiguration is valid!");
      console.log(`Default Model: ${result.data.DEFAULT_MODEL}`);
    } else {
      console.error("\nConfiguration is invalid. Errors:");
      console.error(JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }
  } catch (err) {
    console.error(
      "An error occurred while reading or parsing the config file:",
      err,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
