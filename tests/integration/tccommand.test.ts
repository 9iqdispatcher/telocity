import { describe, expect, test } from "bun:test";

import { main } from "../../src/main.ts";
import { withCapturedConsole } from "../testutils.ts";

describe("TcCommand", () => {
  test("TcCommand should count tokens for qwen", async () => {
    const originalIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      const output = await withCapturedConsole(async () => {
        await main(
          ["tc", "--params", "qwen", "./tests/data/tokens.txt"],
          false,
        );
      });
      expect(output).toContain("3504");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        writable: true,
      });
    }
  });
});
