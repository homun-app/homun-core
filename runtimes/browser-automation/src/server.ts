import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  BrowserAutomationError,
  BrowserRequest,
  makeErrorResponse,
  makeSuccessResponse,
  parseRequestLine,
  serializeResponseLine,
} from "./contracts.js";

export async function handleRequestLine(line: string): Promise<string> {
  let request: BrowserRequest | undefined;
  try {
    request = parseRequestLine(line);
    const result = await dispatch(request);
    return serializeResponseLine(makeSuccessResponse(request.id, result));
  } catch (error) {
    return serializeResponseLine(makeErrorResponse(request?.id ?? "unknown", error));
  }
}

async function dispatch(request: BrowserRequest): Promise<unknown> {
  switch (request.method) {
    case "browser.health":
      return {
        status: "ready",
        transport: "stdio",
      };
    default:
      throw new BrowserAutomationError({
        code: "BROWSER_NOT_IMPLEMENTED",
        message: `${request.method} is not implemented`,
        retryable: false,
      });
  }
}

async function main() {
  const rl = createInterface({ input });
  for await (const line of rl) {
    output.write(await handleRequestLine(line));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
