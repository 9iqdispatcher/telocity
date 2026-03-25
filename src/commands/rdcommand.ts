import { readFile } from "node:fs/promises";
import http from "node:http";

import type { Command } from "../libs/types/index.ts";

import {
  createError,
  generateHelpText,
  log,
  customParseArgs as parseArgs,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";
import { stripGarbageNewLines, validateFiles } from "../libs/LLM/index.ts";
import { basicReader } from "../libs/misc/basicreader.ts";
import { txtBookPaginator } from "../libs/misc/paginatedreader.ts";

export default class RdCommand implements Command {
  static get allowPositionals() {
    return true;
  }
  static get positionalCompletion() {
    return "file" as const;
  }
  static get options() {
    return {
      basic: { type: "boolean", short: "b" },
      help: { type: "boolean", short: "h" },
    } as const;
  }
  async execute(argv: string[]): Promise<number> {
    const { a } = x;
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: (this.constructor as typeof RdCommand).allowPositionals,
      strict: true,
      options: (this.constructor as typeof RdCommand).options,
    });

    const avgHelp = () => {
      const helpText = generateHelpText(
        a.s.help.commands.rd,
        (this.constructor as typeof RdCommand).options,
      );
      log(helpText);
    };

    if (values.help) {
      avgHelp();
      return 0;
    }

    const sourcePath = positionals[1];
    if (!sourcePath) {
      avgHelp();
      throw createError(a.s.e.lllm.sourceRequired, {
        code: "SOURCE_REQUIRED",
      });
    }
    await validateFiles(sourcePath);

    const rawText = await readFile(sourcePath, "utf-8");
    const cleaned = stripGarbageNewLines(rawText, true);
    log(a.s.m.c.rd.ebookLoaded);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/") {
        setTimeout(() => {
          log(a.s.m.c.rd.serverShutdown);
          server.close();
          return 0;
        }, 20000);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (!values.basic) {
          res.end(txtBookPaginator(a.s.m.c.rd, sourcePath));
        } else {
          res.end(basicReader(a.s.m.c.rd, sourcePath));
        }
        return;
      }

      if (url.pathname === "/content") {
        try {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(cleaned);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end(a.s.m.c.rd.notFound);
    });
    server.listen(33636, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : 33636;
      log(
        simpleTemplate(a.s.m.c.rd.serverRunningAt, {
          url: `http://localhost:${port}`,
        }),
      );
      log(simpleTemplate(a.s.m.c.rd.readingFile, { sourcePath }));

      if (!values.basic) {
        log(a.s.m.c.rd.instructions);
      } else {
        log(a.s.m.c.rd.instructions2);
      }
    });
    await new Promise<void>((resolve) => {
      server.on("close", resolve);
    });

    return 0;
  }
}
