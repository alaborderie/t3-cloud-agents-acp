// @ts-check
// Newline-delimited JSON-RPC 2.0 over stdio, both directions.
import * as readline from "node:readline";

/**
 * @typedef {{ jsonrpc?: string, id?: string | number | null, method?: string, params?: any, result?: any, error?: { code: number, message: string } }} JsonRpcMessage
 * @typedef {{
 *   onRequest: (method: string, params: any) => Promise<unknown>,
 *   onNotification: (method: string, params: any) => void,
 * }} Handlers
 */

export class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output @param {Handlers} handlers
 */
export function connect(input, output, handlers) {
  /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  /** @param {JsonRpcMessage} message */
  const send = (message) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    /** @type {JsonRpcMessage} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("cloud-agent-acp ignored a line that is not JSON\n");
      return;
    }
    if (message.method === undefined) {
      const waiter = pending.get(String(message.id));
      pending.delete(String(message.id));
      if (message.error) waiter?.reject(new RpcError(message.error.code, message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.id === undefined || message.id === null) {
      handlers.onNotification(message.method, message.params ?? {});
      return;
    }
    const id = message.id;
    handlers.onRequest(message.method, message.params ?? {}).then(
      (result) => send({ id, result }),
      (/** @type {Error & { code?: number }} */ error) => {
        process.stderr.write(`cloud-agent-acp ${message.method} failed: ${error.message}\n`);
        send({ id, error: { code: error.code ?? -32603, message: error.message } });
      },
    );
  });

  return {
    closed: new Promise((resolve) => lines.once("close", resolve)),
    /** @param {string} method @param {unknown} params */
    notify: (method, params) => send({ method, params }),
    /** @param {string} method @param {unknown} params @returns {Promise<any>} */
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(String(id), { resolve, reject });
        send({ id, method, params });
      }),
  };
}

/** @typedef {ReturnType<typeof connect>} Connection */
