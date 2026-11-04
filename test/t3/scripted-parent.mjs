#!/usr/bin/env node
// @ts-check
// A parent agent for proofs, so no paid model is needed: a message that starts with JSON
// {"tool": name, "args": {...}} becomes one call to T3's MCP tools, and the result is the
// reply. Any other message, such as T3's wake messages, is echoed back as "ack: <text>".
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";

import { userRequest } from "../../src/config.mjs";
import { callT3Tool, t3McpEndpoint } from "../../src/t3-mcp.mjs";

/** @type {Map<string, import("../../src/t3-mcp.mjs").T3McpEndpoint | null>} */
const sessions = new Map();
const send = (/** @type {any} */ message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

/** @param {string} text */
function leadingJson(text) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error("unterminated JSON");
}

/** @param {any} params */
async function prompt(params) {
  const request = userRequest(params.prompt ?? []);
  let reply = `ack: ${request}`;
  if (request.startsWith("{")) {
    const endpoint = sessions.get(params.sessionId);
    try {
      if (!endpoint) throw new Error("T3 passed no MCP server");
      const { tool, args } = leadingJson(request);
      reply = JSON.stringify(await callT3Tool(endpoint, tool, args ?? {}));
    } catch (error) {
      reply = `scripted-parent error: ${/** @type {Error} */ (error).message}`;
    }
  }
  send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
  return { stopReason: "end_turn" };
}

const models = { currentModelId: "script", availableModels: [{ modelId: "script", name: "Script" }] };

/** @param {string} method @param {any} params */
async function handle(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } }, authMethods: [], agentInfo: { name: "scripted-parent", version: "1" } };
    case "session/new": {
      const sessionId = `parent-${randomUUID()}`;
      sessions.set(sessionId, t3McpEndpoint(params.mcpServers));
      return { sessionId, models };
    }
    case "session/load":
      sessions.set(String(params.sessionId), t3McpEndpoint(params.mcpServers));
      return { models };
    case "session/prompt":
      return prompt(params);
    default:
      return {};
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined || message.id === null) return;
  handle(message.method, message.params ?? {}).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
  );
});
