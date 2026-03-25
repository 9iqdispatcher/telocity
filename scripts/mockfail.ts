#!/usr/bin/env bun

import type { IncomingMessage, ServerResponse } from "node:http";

import * as http from "node:http";

const MAX_ATTEMPTS = 7;
const MOCK_PORT = 8080;

const SHOULD_TIMEOUT_MODE = process.argv.includes("--timeout");
const TIMEOUT_DELAY_MS = 5000;

const failureTracker = new Map<string, number>();

interface LLMRequestPayload {
  stream?: boolean;
  temperature?: number;
  messages?: unknown[];
  input?: unknown;
  prompt?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function generateRandomParagraph(): string {
  const chunks = [
    "The integration of the neural architecture allows for seamless transitions between states.",
    "Observations indicate that the temperature parameter significantly alters the stochastic nature of the output tokens.",
    "In a production environment, individual task retries are essential for maintaining the integrity of the batch processing pipeline.",
    "Data streams were analyzed for consistency, ensuring that the simulated inference provides a realistic test case for the client-side logic.",
    "The quick brown fox jumps over the lazy dog, while the system monitors for potential 500 errors and network timeouts.",
    "By incrementing the seed or temperature, the user can explore the latent space of the model's predictive capabilities.",
  ];
  return chunks.sort(() => Math.random() - 0.5).join(" ");
}

async function streamWords(
  res: ServerResponse,
  fullText: string,
  chunkFormatter: (chunk: string) => unknown,
  doneHook?: () => void,
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const words = fullText.split(" ");
  for (let i = 0; i < words.length; i++) {
    const chunk = words[i] + (i === words.length - 1 ? "" : " ");
    res.write(`data: ${JSON.stringify(chunkFormatter(chunk))}\n\n`);
    await sleep(50);
  }

  if (doneHook) {
    doneHook();
  } else {
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

async function handleChatCompletions(
  res: ServerResponse,
  isStream: boolean,
  text: string,
) {
  if (isStream) {
    await streamWords(res, text, (chunk) => ({
      choices: [{ delta: { content: chunk } }],
    }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: text } }],
      }),
    );
  }
}

async function handleResponses(
  res: ServerResponse,
  isStream: boolean,
  text: string,
) {
  if (isStream) {
    await streamWords(
      res,
      text,
      (chunk) => ({ type: "response.output_text.delta", delta: chunk }),
      () =>
        res.write(
          `data: ${JSON.stringify({ type: "response.output_text.done", text })}\n\n`,
        ),
    );
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: text }],
          },
        ],
      }),
    );
  }
}

async function handleCompletions(
  res: ServerResponse,
  isStream: boolean,
  text: string,
) {
  if (isStream) {
    await streamWords(res, text, (chunk) => ({ choices: [{ text: chunk }] }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ text: text }],
      }),
    );
  }
}

async function requestHandler(req: IncomingMessage, res: ServerResponse) {
  console.log(
    "\n================================================================",
  );
  console.log(
    `[MOCK] Received request: ${req.method ?? "UNKNOWN"} ${req.url ?? ""}`,
  );

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const bodyString = Buffer.concat(chunks).toString("utf-8");

  let promptKey = bodyString;
  let isStreaming = false;
  let currentTemp = 0;

  try {
    const payload = JSON.parse(bodyString) as LLMRequestPayload;
    isStreaming = !!payload.stream;
    currentTemp = payload.temperature ?? 0;

    if (payload.messages) promptKey = JSON.stringify(payload.messages);
    else if (payload.input) promptKey = JSON.stringify(payload.input);
    else if (payload.prompt) promptKey = JSON.stringify(payload.prompt);
  } catch {
    console.error("[MOCK] Warning: Could not parse request body as JSON.");
  }

  const url = req.url ?? "";

  const attempts = failureTracker.get(promptKey) ?? 0;

  if (SHOULD_TIMEOUT_MODE) {
    if (attempts < MAX_ATTEMPTS) {
      console.log(
        `\x1b[33m[MOCK] TIMEOUT MODE: Delaying 5s (Attempt ${attempts + 1}/${MAX_ATTEMPTS})\x1b[0m`,
      );
      failureTracker.set(promptKey, attempts + 1);
      await sleep(TIMEOUT_DELAY_MS);
    } else {
      console.log(
        `\x1b[32m[MOCK] TIMEOUT MODE: Delay removed (Attempt ${attempts + 1})\x1b[0m`,
      );
    }
  } else {
    if (attempts < MAX_ATTEMPTS) {
      failureTracker.set(promptKey, attempts + 1);
      console.log(
        `\x1b[31m[MOCK] STATUS: FAILED (Attempt ${attempts + 1}/${MAX_ATTEMPTS})\x1b[0m`,
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Simulated task failure." } }),
      );
      return;
    }
  }

  const responseText = generateRandomParagraph();
  console.log(
    `\x1b[32m[MOCK] STATUS: SUCCESS | Temp: ${currentTemp} | Stream: ${isStreaming}\x1b[0m`,
  );

  try {
    if (url.includes("/v1/chat/completions")) {
      await handleChatCompletions(res, isStreaming, responseText);
    } else if (url.includes("/v1/responses")) {
      await handleResponses(res, isStreaming, responseText);
    } else if (url.includes("/v1/completions")) {
      await handleCompletions(res, isStreaming, responseText);
    } else {
      console.log(`\x1b[31m[MOCK] Unknown endpoint requested: ${url}\x1b[0m`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not mocked." }));
    }
  } catch (err) {
    console.error("[MOCK] Error handling response:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Mock Error" }));
    }
  }
}

const server = http.createServer((req, res) => {
  void requestHandler(req, res);
});

server.listen(MOCK_PORT, () => {
  console.log(
    "================================================================",
  );
  console.log(`  MOCK SERVER RUNNING ON http://localhost:${MOCK_PORT}`);
  console.log(`  SUPPORTED ENDPOINTS:`);
  console.log(`   - /v1/chat/completions`);
  console.log(`   - /v1/responses`);
  console.log(`   - /v1/completions`);
  console.log("");
  if (SHOULD_TIMEOUT_MODE) {
    console.log(`  MODE: \x1b[33mTIMEOUT SIMULATION\x1b[0m`);
    console.log(
      `  BEHAVIOR: ${MAX_ATTEMPTS} Delays (${TIMEOUT_DELAY_MS / 1000}s) -> 1 Success (No delay)`,
    );
  } else {
    console.log(`  MODE: \x1b[34mSTANDARD ERROR SIMULATION\x1b[0m`);
    console.log(`  BEHAVIOR: ${MAX_ATTEMPTS} Failures (HTTP 500) -> 1 Success`);
  }
  console.log(
    "================================================================",
  );
});
