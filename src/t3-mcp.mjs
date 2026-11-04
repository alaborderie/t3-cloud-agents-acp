// @ts-check
// Calls T3's MCP tools from an ACP agent that T3 started.

/** @typedef {{ url: string, authorization: string }} T3McpEndpoint */

/**
 * T3 hands a local ACP command its MCP server as a stdio bridge process whose environment
 * names the HTTP endpoint, at session/new and again at session/load.
 * @param {unknown} servers @returns {T3McpEndpoint | null}
 */
export function t3McpEndpoint(servers) {
  for (const server of Array.isArray(servers) ? servers : []) {
    const env = Object.fromEntries((Array.isArray(server?.env) ? server.env : []).map((/** @type {any} */ e) => [e?.name, e?.value]));
    if (typeof env.T3_ACP_MCP_ENDPOINT === "string") {
      return { url: env.T3_ACP_MCP_ENDPOINT, authorization: String(env.T3_ACP_MCP_AUTHORIZATION ?? "") };
    }
  }
  return null;
}

/**
 * Calls one tool over MCP streamable HTTP. Rejects on an HTTP, JSON-RPC, or tool error.
 * @param {T3McpEndpoint} endpoint @param {string} tool @param {unknown} args
 * @returns {Promise<{ content?: { type: string, text?: string }[], structuredContent?: any, isError?: boolean }>}
 */
export async function callT3Tool(endpoint, tool, args, timeoutMs = 15_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: endpoint.authorization };
  /** @param {object} body @param {string | null} session */
  const post = async (body, session) => {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: session ? { ...headers, "mcp-session-id": session } : headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`T3 MCP returned ${res.status}: ${raw.slice(0, 300)}`);
    const json = raw.trimStart().startsWith("{")
      ? raw
      : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("");
    /** @type {any} */
    const message = json ? JSON.parse(json) : null;
    if (message?.error) throw new Error(`T3 MCP ${tool}: ${message.error.message}`);
    return { session: res.headers.get("mcp-session-id") ?? session, result: message?.result };
  };
  const init = await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cloud-agent-acp", version: "1" } } }, null);
  await post({ method: "notifications/initialized" }, init.session);
  const { result } = await post({ id: 2, method: "tools/call", params: { name: tool, arguments: args } }, init.session);
  if (result?.isError) {
    throw new Error(`T3 MCP ${tool}: ${(result.content ?? []).map((/** @type {any} */ c) => c.text ?? "").join(" ").slice(0, 300)}`);
  }
  return result;
}
