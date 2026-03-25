import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { AppStateSingleton } from "../../src/libs/core/index.ts";
import {
  calcAvgLineLength,
  calcAvgLineLengthBytes,
  stripGarbageNewLines,
} from "../../src/libs/LLM/index.ts";
import {
  initTest,
  setupTestEnvironment,
  teardownTestEnvironment,
  TestEnvironment,
} from "../testutils.ts";

describe("LLM utils (text helpers)", () => {
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

  beforeEach(() => {
    process.env["LC_ALL"] = "en_US.UTF-8";
    process.env["LANG"] = "en_US.UTF-8";
  });
  test("stripGarbageNewLines removes line separators and preserves content", () => {
    const src = "Line1\u2028Line2\u2029\nLine3\r\n\n\n";
    const result = stripGarbageNewLines(src, false);
    expect(result).toContain("Line1");
    expect(result).toContain("Line2");
    expect(result).toContain("Line3");
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("stripGarbageNewLines with stripEmpty trims leading/trailing empties", () => {
    const src = "\n\n  \nAlpha\n\nBeta\n\n  \n";
    const result = stripGarbageNewLines(src, true);
    expect(result.split("\n")[0]).toBe("Alpha");
    expect(result.split("\n").slice(-1)[0]).toBe("Beta");
  });

  test("stripGarbageNewLines throws on invalid type", () => {
    //@ts-expect-error Intentional type error for test
    expect(() => stripGarbageNewLines(123)).toThrow(TypeError);
  });

  test("calcAvgLineLength counts graphemes per non-empty line", () => {
    const text = "a\nab\nabc\n";
    const avg = calcAvgLineLength(text);
    expect(typeof avg).toBe("number");
    expect(avg).toBe(2);
  });

  test("calcAvgLineLength counts graphemes per non-empty line", () => {
    const text = "a\nab\nabc\n";
    const avg = calcAvgLineLength(text);
    expect(typeof avg).toBe("number");
    expect(avg).toBe(2);
  });

  test("calcAvgLineLength/Bytes return 0 for empty content or only blank lines", () => {
    expect(calcAvgLineLength("")).toBe(0);
    expect(calcAvgLineLengthBytes("")).toBe(0);
    expect(calcAvgLineLength("\n\n")).toBe(0);
    expect(calcAvgLineLengthBytes("\n\n")).toBe(0);
  });
});
