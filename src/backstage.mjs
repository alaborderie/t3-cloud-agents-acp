// @ts-check
// Client for the Backstage cloud-agents API, version 1. The token never leaves the headers.

/**
 * @typedef {import("./mapping.mjs").AgentEnvelope} AgentEnvelope
 * @typedef {{ questionId: string, runId: string, question: string, options?: string[] }} OpenQuestion
 * @typedef {{ id: string, status: import("./mapping.mjs").AgentStatus, branch?: string, prUrl?: string | null, openQuestions?: OpenQuestion[] }} Agent
 * @typedef {{ repo: string, base: string, branch?: string, prompt: string, title?: string, tier?: string, harness?: string, model?: string, effort?: string, parent?: { source: "t3", threadId?: string, label?: string } }} CreateAgentRequest
 */

export class BackstageError extends Error {
  /** @param {string} method @param {string} path @param {number} status @param {string} body */
  constructor(method, path, status, body) {
    super(`Backstage ${method} ${path} returned ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

/** @param {{ backstageUrl: string, token: string }} config */
export function backstageClient(config) {
  const base = `${config.backstageUrl.replace(/\/+$/, "")}/api/cloud-agents`;
  const auth = { authorization: `Bearer ${config.token}` };

  /** @param {string} method @param {string} path @param {unknown} [body] */
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new BackstageError(method, path, res.status, text);
    return text ? JSON.parse(text) : null;
  }

  const agentPath = (/** @type {string} */ id) => `/agents/${encodeURIComponent(id)}`;

  return {
    /** @param {CreateAgentRequest} request @returns {Promise<Agent>} */
    createAgent: (request) => call("POST", "/agents", request),
    /** @param {string} id @returns {Promise<Agent>} */
    getAgent: (id) => call("GET", agentPath(id)),
    /** @param {string} id @param {string} questionId @param {string} answer */
    reply: (id, questionId, answer) => call("POST", `${agentPath(id)}/reply`, { questionId, answer }),
    /** @param {string} id @param {string} text */
    message: (id, text) => call("POST", `${agentPath(id)}/messages`, { text }),
    /** @param {string} id */
    stop: (id) => call("POST", `${agentPath(id)}/stop`),

    /**
     * Streams envelopes after `after` until the server closes the stream or `signal` aborts.
     * @param {string} id @param {number} after @param {AbortSignal} signal
     * @returns {AsyncGenerator<AgentEnvelope>}
     */
    async *events(id, after, signal) {
      const query = after >= 0 ? `?after=${after}` : "";
      const res = await fetch(`${base}${agentPath(id)}/events${query}`, {
        headers: { ...auth, accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || res.body === null) {
        throw new BackstageError("GET", `${agentPath(id)}/events`, res.status, await res.text());
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) yield JSON.parse(data);
        }
      }
    },
  };
}

/** @typedef {ReturnType<typeof backstageClient>} BackstageClient */
