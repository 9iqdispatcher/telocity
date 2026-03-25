#!/usr/bin/env bun

import { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";

const PORT: number = 8080;

const MARKDOWN_HELL_MODE = process.argv.includes("--markdown");

const STREAM_LATENCY_MS: number = 0;
const DEFAULT_LATENCY_MS: number = 50;
const MARKDOWN_REPETITIONS: number = 100;
const CHUNK_SIZE_CHARS: number = 5;

const BASE_MARKDOWN = `
# Markdown Stress Test

This is a paragraph to test basic text rendering, including **bold**, *italics*, and \`inline code\`.

## 1. Tables
| Feature | Supported | Description |
| :--- | :---: | :--- |
| **Streaming** | ✅ | Chunked data delivery |
| **Markdown** | ✅ | Tables, lists, quotes |
| **Latency** | ✅ | Configurable delay |

## 2. Nested Lists
- Parent Item 1
  - Child Item 1.1
    - Grandchild 1.1.1
    - Grandchild 1.1.2
  - Child Item 1.2
- Parent Item 2
  1. Numbered Child 2.1
  2. Numbered Child 2.2

## 3. Code Blocks
> "nyo nyo nyo."

\`\`\`typescript
function stressTest(chunks: string[]) {
  for (const chunk of chunks) {
    process(chunk);
  }
}
\`\`\`

---
`;

const FULL_MARKDOWN = BASE_MARKDOWN.repeat(MARKDOWN_REPETITIONS);

function getTextChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

const TEXT_CHUNKS = getTextChunks(FULL_MARKDOWN, CHUNK_SIZE_CHARS);

function handleChatCompletions(res: ServerResponse, isStream: boolean) {
  if (isStream) {
    if (MARKDOWN_HELL_MODE) {
      const streamPayloads = TEXT_CHUNKS.map((chunk) => ({
        choices: [{ delta: { content: chunk } }],
      }));
      sendStream(res, streamPayloads);
    } else {
      sendStream(res, [
        { choices: [{ delta: { content: "Mock " } }] },
        { choices: [{ delta: { content: "chat " } }] },
        { choices: [{ delta: { content: "completion " } }] },
        { choices: [{ delta: { content: "stream." } }] },
      ]);
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    const content = MARKDOWN_HELL_MODE
      ? FULL_MARKDOWN
      : "Mock chat completion batch response.";
    res.end(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
    );
  }
}

function handleResponses(res: ServerResponse, isStream: boolean) {
  if (isStream) {
    if (MARKDOWN_HELL_MODE) {
      const streamPayloads: unknown[] = TEXT_CHUNKS.map((chunk) => ({
        type: "response.output_text.delta",
        delta: chunk,
      }));
      streamPayloads.push({
        type: "response.output_text.done",
        text: FULL_MARKDOWN,
      });
      sendStream(res, streamPayloads);
    } else {
      sendStream(res, [
        { type: "response.output_text.delta", delta: "Mock " },
        { type: "response.output_text.delta", delta: "responses " },
        { type: "response.output_text.delta", delta: "stream." },
        { type: "response.output_text.done", text: "Mock responses stream." },
      ]);
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    const text = MARKDOWN_HELL_MODE
      ? FULL_MARKDOWN
      : "Mock responses batch response.";
    res.end(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text }],
          },
        ],
      }),
    );
  }
}

function handleCompletions(res: ServerResponse, isStream: boolean) {
  if (isStream) {
    if (MARKDOWN_HELL_MODE) {
      const streamPayloads = TEXT_CHUNKS.map((chunk) => ({
        choices: [{ text: chunk }],
      }));
      sendStream(res, streamPayloads);
    } else {
      sendStream(res, [
        { choices: [{ text: "Mock " }] },
        { choices: [{ text: "legacy " }] },
        { choices: [{ text: "completions " }] },
        { choices: [{ text: "stream." }] },
      ]);
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    const text = MARKDOWN_HELL_MODE
      ? FULL_MARKDOWN
      : "Mock legacy completions batch response.";
    res.end(
      JSON.stringify({
        choices: [{ text }],
      }),
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendStream(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const latency = MARKDOWN_HELL_MODE ? STREAM_LATENCY_MS : DEFAULT_LATENCY_MS;

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (latency > 0) {
      await sleep(latency);
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function requestHandler(req: IncomingMessage, res: ServerResponse) {
  console.log(
    "\n================================================================",
  );
  console.log(
    `[MOCK] Received request: ${req.method ?? "UNKNOWN"} ${req.url ?? ""}`,
  );
  console.log("[MOCK] Request Headers:", req.headers);

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf-8");
  });

  req.on("end", () => {
    if (!MARKDOWN_HELL_MODE) {
      console.log("[MOCK] Request Body:", body);
    }

    let payload: Record<string, unknown> = {};
    if (body) {
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        console.error("[MOCK] Warning: Could not parse request body as JSON.");
      }
    }

    const isStream = payload["stream"] === true;
    const url = req.url ?? "";

    if (url.includes("/v1/chat/completions")) {
      console.log(
        `[MOCK] Routing to Chat Completions (Stream: ${String(isStream)})`,
      );
      handleChatCompletions(res, isStream);
    } else if (url.includes("/v1/responses")) {
      console.log(`[MOCK] Routing to Responses (Stream: ${String(isStream)})`);
      handleResponses(res, isStream);
    } else if (url.includes("/v1/completions")) {
      console.log(
        `[MOCK] Routing to Legacy Completions (Stream: ${String(isStream)})`,
      );
      handleCompletions(res, isStream);
    } else {
      console.log(`[MOCK] Unknown endpoint requested: ${url}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not mocked." }));
    }
  });

  req.on("error", (err: Error) => {
    console.error("[MOCK] Error with incoming request:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "Internal Server Error", details: err.message }),
    );
  });
}

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(
    "================================================================",
  );
  console.log(`  Mock Server is running on http://localhost:${PORT}`);

  if (MARKDOWN_HELL_MODE) {
    console.log(`  Mode: 😈 MARKDOWN HELL (Stress Test)`);
    console.log(
      `  - Repetitions: ${MARKDOWN_REPETITIONS} (${FULL_MARKDOWN.length} chars)`,
    );
    console.log(`  - Stream Latency: ${STREAM_LATENCY_MS}ms per chunk`);
    console.log(`  - Chunk Size: ${CHUNK_SIZE_CHARS} characters`);
  } else {
    console.log(`  Mode: 😇 STANDARD (Simple Mocks)`);
  }

  console.log(`  Supporting endpoints:`);
  console.log(`   - /v1/chat/completions`);
  console.log(`   - /v1/responses`);
  console.log(`   - /v1/completions`);
  console.log(
    "================================================================",
  );
});
