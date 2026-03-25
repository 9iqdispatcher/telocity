import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs/promises";

import type { ConfigModelVariant } from "../../src/libs/types/index.ts";

import {
  config as appConfig,
  AppStateSingleton,
} from "../../src/libs/core/index.ts";
import { main } from "../../src/main.ts";
import {
  cleanupProgressEntryForSource,
  initTest,
  setupTestEnvironment,
  SOURCE_FILE,
  teardownTestEnvironment,
  TestEnvironment,
  withCapturedConsole,
} from "../testutils.ts";

await initTest();
const modelConfig = appConfig.PARAM_CONFIGS[appConfig.DEFAULT_MODEL];

if (!modelConfig) {
  throw new Error(
    `Default model '${appConfig.DEFAULT_MODEL}' not found in PARAM_CONFIGS. Check your test configuration.`,
  );
}

let activeConfig: ConfigModelVariant;
switch (modelConfig.reasoningType) {
  case "reason_and_instruct":
    activeConfig = modelConfig.instruct;
    break;
  case "instruct_only":
    activeConfig = modelConfig.default;
    break;
  case "reason_only":
    activeConfig = modelConfig.default;
    break;
  default: {
    const _exhaustiveCheck: never = modelConfig;
    throw new Error(
      `Unhandled reasoning type in test setup: ${
        (_exhaustiveCheck as { reasoningType: string })?.reasoningType
      }`,
    );
  }
}

describe("Transform Command (Default Args)", () => {
  let testEnv: TestEnvironment;
  let appState;
  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    appState = AppStateSingleton.getInstance();
    Object.defineProperty(appState, "DEBUG_MODE", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterAll(async () => {
    await teardownTestEnvironment(testEnv);
  });

  beforeEach(async () => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
    await fs.rm(testEnv.targetFile, { force: true });
  });

  afterEach(async () => {
    await cleanupProgressEntryForSource();
  });

  test("handles default arguments correctly", async () => {
    const args = [
      "tf",
      SOURCE_FILE,
      testEnv.targetFile,
      "--debug",
      "--wait",
      "0.005",
    ];
    const output = await withCapturedConsole(async () => {
      await main(args, false);
    });

    const expectedUrl = activeConfig.model.url ?? appConfig.URL;

    [
      "Write a summary, in English, of the following file",
      `chunkSize":200000`,
      `batchSize":1`,
      `url":"${expectedUrl}`,
    ].forEach((expected) => expect(output).toContain(expected));
  });
});
