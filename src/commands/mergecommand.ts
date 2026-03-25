import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  errlog,
  exitOne,
  generateHelpText,
  isEnoentError,
  log,
  customParseArgs as parseArgs,
  red,
  blue,
  x,
} from "../libs/core/index.ts";
import { mergeFiles } from "../libs/LLM/index.ts";

export default class MergeCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "directory" as const;
  }
  static get options() {
    return {
      extension: { type: "string", short: "e" },
      include: { type: "string", short: "i" },
      exclude: { type: "string", short: "x" },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const internalOptions = {
      debug: { type: "boolean", short: "d" },
    } as const;
    const optionsForParser = {
      ...(this.constructor as typeof MergeCommand).options,
      ...internalOptions,
    };
    const { values: argValues, positionals } = parseArgs({
      args: argv,
      options: optionsForParser,
      allowPositionals: (this.constructor as typeof MergeCommand)
        .allowPositionals,
      strict: true,
    });

    const mergeHelp = () => {
      const helpText = generateHelpText(
        a.s.help.commands.mg,
        (this.constructor as typeof MergeCommand).options,
      );
      log(helpText);
    };

    if (argValues.help) {
      mergeHelp();
      return 0;
    }

    if (!positionals[1]) {
      exitOne();
      mergeHelp();
      throw createError(a.s.e.lllm.sourceRequired, {
        code: "SOURCE_REQUIRED",
      });
    }

    const sourcePath = positionals[1];
    const targetPath = positionals[2] ? positionals[2] : process.cwd();
    const extension = argValues.extension;

    if (!extension) {
      exitOne();
      errlog(red(a.s.e.c.mg.extensionRequired));
      return 1;
    }

    const includePatterns: string[] = [];
    const excludePatterns: string[] = [];

    const parsePatternStr = (str: string) =>
      str
        .split(":")
        .map((p) => p.trim())
        .filter(Boolean);

    if (argValues.include) {
      includePatterns.push(...parsePatternStr(argValues.include));
    }

    if (argValues.exclude) {
      excludePatterns.push(...parsePatternStr(argValues.exclude));
    }

    const readGlobFile = async (filePath: string, destArray: string[]) => {
      try {
        const content = await readFile(filePath, "utf-8");
        const patterns = content
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter((p) => p && !p.startsWith("#"));
        if (patterns.length > 0) {
          destArray.push(...patterns);
        }
      } catch (err) {
        if (!isEnoentError(err)) {
          throw err;
        }
      }
    };

    const cwd = process.cwd();
    const resolvedSource = path.resolve(cwd, sourcePath);

    const checkPaths = new Set<string>();
    checkPaths.add(cwd);
    checkPaths.add(resolvedSource);

    for (const dir of checkPaths) {
      await readGlobFile(path.join(dir, ".mginclude"), includePatterns);
      await readGlobFile(path.join(dir, ".mgignore"), excludePatterns);
    }

    const uniqueIncludes = [...new Set(includePatterns)];
    const uniqueExcludes = [...new Set(excludePatterns)];

    if (a.DEBUG_MODE) {
      log(blue(`Final patterns after reading CLI and .mg files:`));
      log("Includes:", uniqueIncludes);
      log("Excludes:", uniqueExcludes);
    }

    await mergeFiles(
      sourcePath,
      targetPath,
      extension,
      uniqueIncludes,
      uniqueExcludes,
    );

    return 0;
  }
}
