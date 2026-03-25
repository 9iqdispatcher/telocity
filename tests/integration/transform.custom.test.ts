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

import { AppStateSingleton } from "../../src/libs/core/index.ts";
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

describe("Transform Command (Custom Args)", () => {
  let testEnv: TestEnvironment;
  let appState;
  beforeAll(async () => {
    await initTest();
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

  test("handles custom arguments correctly", async () => {
    const customArgs = [
      "tf",
      "--debug",
      SOURCE_FILE,
      testEnv.targetFile,
      "-c",
      "4",
      "-b",
      "3",
      "-m",
      "johndoe",
      "-i",
      "just testing things",
      "-u",
      "http://nowhere.to",
      "--wait",
      "0.005",
    ];
    const output = await withCapturedConsole(async () => {
      await main(customArgs, false);
    });

    [
      "just testing things",
      `chunkSize":4`,
      `batchSize":3`,
      `model":[true,"johndoe"]`,
      `url":"http://nowhere.to"`,
    ].forEach((expected) => expect(output).toContain(expected));
  });
});
