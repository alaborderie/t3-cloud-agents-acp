// @ts-check
// ACP agent that runs each T3 session as one Backstage cloud agent.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { RpcError } from "./acp.mjs";
import { parseBrief, resolveTarget, userRequest } from "./config.mjs";
import { TERMINAL_STATUSES, finalSummary, initialStreamState, step } from "./mapping.mjs";

/**
 * @typedef {import("./config.mjs").Config} Config
 * @typedef {import("./backstage.mjs").BackstageClient} BackstageClient
 * @typedef {import("./backstage.mjs").Agent} Agent
 * @typedef {import("./acp.mjs").Connection} Connection
 * @typedef {import("./mapping.mjs").StreamState} StreamState
 * @typedef {import("./mapping.mjs").SessionUpdate} SessionUpdate
 * @typedef {{ cwd: string, modelId: string, agentId: string | null, stream: StreamState }} SessionRecord
 * @typedef {SessionRecord & { id: string, turn: AbortController | null }} Session
 * @typedef {{ stopReason: "end_turn" | "cancelled" }} PromptResult
 */

const VERSION = "0.1.0";
// T3 sends this prompt after a restart cut a turn short; it is not a message for the agent.
const RESUME_PROMPT = "Continue where you left off.";
const RECONNECT_MS = 1_000;
const MAX_STREAM_FAILURES = 30;

class Cancelled extends Error {}

/** @param {number} ms @param {AbortSignal} signal */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true });
  });

/** @template T @param {Promise<T>} promise @param {AbortSignal} signal @returns {Promise<T>} */
const unlessAborted = (promise, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    signal.addEventListener("abort", () => reject(new Cancelled()), { once: true });
    promise.then(resolve, reject);
  });

/** @param {string} stateDir */
function sessionStore(stateDir) {
  const dir = path.join(stateDir, "sessions");
  const file = (/** @type {string} */ id) => path.join(dir, `${encodeURIComponent(id)}.json`);
  return {
    /** @param {string} id @returns {SessionRecord | null} */
    load: (id) => (fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), "utf8")) : null),
    /** @param {Session} session */
    save(session) {
      fs.mkdirSync(dir, { recursive: true });
      /** @type {SessionRecord} */
      const record = { cwd: session.cwd, modelId: session.modelId, agentId: session.agentId, stream: session.stream };
      const tmp = `${file(session.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, file(session.id));
    },
  };
}

/** @param {{ config: Config, client: BackstageClient, acp: () => Connection }} deps */
export function createBridge({ config, client, acp }) {
  const store = sessionStore(config.stateDir);
  /** @type {Map<string, Session>} */
  const sessions = new Map();

  const models = (/** @type {string} */ current) => ({
    currentModelId: current,
    availableModels: config.models.map((m) => ({ modelId: m.id, name: m.name })),
  });

  /** @param {string} id */
  const sessionOf = (id) => {
    const session = sessions.get(id);
    if (!session) throw new RpcError(-32602, `Unknown session ${id}`);
    return session;
  };

  /** @param {Session} session @param {SessionUpdate} update */
  const show = (session, update) => acp().notify("session/update", { sessionId: session.id, update });

  /** @param {Session} session @param {string} text */
  const note = (session, text) => show(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

  /** @param {string} modelId */
  function modelFields(modelId) {
    const choice = config.models.find((m) => m.id === modelId);
    if (!choice) throw new RpcError(-32602, `Unknown model ${modelId}`);
    if (choice.tier) return { tier: choice.tier };
    return { harness: choice.harness, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) };
  }

  /**
   * Shows the open questions as one T3 question and posts each answer.
   * @returns {Promise<"answered" | "dismissed">}
   */
  async function ask(/** @type {Session} */ session, /** @type {string} */ agentId, /** @type {AbortSignal} */ signal) {
    const agent = await client.getAgent(agentId);
    const questions = agent.openQuestions ?? [];
    if (questions.length === 0) return "answered";
    const properties = Object.fromEntries(
      questions.map((q, index) => [
        q.questionId,
        {
          type: "string",
          title: questions.length === 1 ? "Cloud agent" : `Question ${index + 1}`,
          description: q.question,
          ...(q.options?.length ? { enum: q.options } : {}),
        },
      ]),
    );
    const response = await unlessAborted(
      acp().request("elicitation/create", {
        sessionId: session.id,
        mode: "form",
        message: questions.length === 1 ? questions[0].question : `The cloud agent asks ${questions.length} questions.`,
        requestedSchema: { type: "object", properties, required: Object.keys(properties) },
      }),
      signal,
    );
    if (response?.action !== "accept") return "dismissed";
    for (const q of questions) {
      const answer = response.content?.[q.questionId];
      if (answer !== undefined && answer !== null && String(answer).trim()) {
        await client.reply(agentId, q.questionId, String(answer));
      }
    }
    return "answered";
  }

  /**
   * Shows the agent's events until it reaches a terminal status.
   * @param {Session} session @param {Agent} agent @param {boolean} awaitingRun a message or answer was just sent, so the agent's current terminal status is stale
   * @param {AbortSignal} signal @returns {Promise<PromptResult>}
   */
  async function follow(session, agent, awaitingRun, signal) {
    const agentId = agent.id;
    if (agent.status === "needs_input" && !awaitingRun) {
      if ((await ask(session, agentId, signal)) === "dismissed") return waiting(session, agentId);
      awaitingRun = true;
    }
    let failures = 0;
    for (;;) {
      try {
        for await (const envelope of client.events(agentId, session.stream.lastSeq, signal)) {
          const result = step(session.stream, envelope);
          if (result.state === session.stream) continue;
          session.stream = result.state;
          store.save(session);
          failures = 0;
          awaitingRun = false;
          for (const update of result.updates) show(session, update);
          if (result.signal?.type === "needs_input") {
            if ((await ask(session, agentId, signal)) === "dismissed") return waiting(session, agentId);
            awaitingRun = true;
          } else if (result.signal?.type === "terminal") {
            return finish(session, await client.getAgent(agentId));
          }
        }
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled();
        if (/** @type {any} */ (error).status >= 400 && /** @type {any} */ (error).status < 500) throw error;
        if (++failures > MAX_STREAM_FAILURES) throw error;
      }
      if (signal.aborted) throw new Cancelled();
      const latest = await client.getAgent(agentId);
      if (TERMINAL_STATUSES.has(latest.status) && !awaitingRun) return finish(session, latest);
      await sleep(RECONNECT_MS, signal);
    }
  }

  /** @param {Session} session @param {Agent} agent @returns {PromptResult} */
  function finish(session, agent) {
    show(session, finalSummary(agent, session.stream.lastRun));
    if (agent.status === "failed") {
      throw new RpcError(-32603, `Cloud agent ${agent.id} failed: ${session.stream.lastRun?.error ?? "see the thread"}`);
    }
    return { stopReason: agent.status === "stopped" ? "cancelled" : "end_turn" };
  }

  /** @param {Session} session @param {string} agentId @returns {PromptResult} */
  function waiting(session, agentId) {
    show(session, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Cloud agent ${agentId} still needs input. Send a message to this thread to answer it.` },
    });
    return { stopReason: "end_turn" };
  }

  /** @param {Session} session @param {any[]} blocks @param {AbortSignal} signal @returns {Promise<PromptResult>} */
  async function prompt(session, blocks, signal) {
    const text = userRequest(blocks);
    if (session.agentId === null) {
      const brief = parseBrief(text);
      const { repo, base } = resolveTarget(brief, config, session.cwd);
      const agent = await client.createAgent({
        repo,
        base,
        ...(brief.branch ? { branch: brief.branch } : {}),
        prompt: brief.prompt,
        title: brief.prompt.split("\n")[0].slice(0, 80),
        ...modelFields(session.modelId),
        parent: { source: "t3", label: session.id },
      });
      session.agentId = agent.id;
      store.save(session);
      note(session, `Cloud agent ${agent.id} created for ${repo} (base ${base}).\n`);
      return follow(session, agent, false, signal);
    }
    const agent = await client.getAgent(session.agentId);
    if (text.startsWith(RESUME_PROMPT)) return follow(session, agent, false, signal);
    if (agent.status === "needs_input") {
      for (const q of agent.openQuestions ?? []) await client.reply(agent.id, q.questionId, text);
      return follow(session, agent, true, signal);
    }
    if (TERMINAL_STATUSES.has(agent.status)) {
      await client.message(agent.id, text);
      return follow(session, agent, true, signal);
    }
    note(session, `Cloud agent ${agent.id} is ${agent.status}; Backstage takes a message only between runs, so this one was not sent.\n`);
    return follow(session, agent, false, signal);
  }

  /** @param {Session} session @param {any[]} blocks @returns {Promise<PromptResult>} */
  async function runTurn(session, blocks) {
    if (session.turn) throw new RpcError(-32600, `Session ${session.id} already has a running prompt`);
    const turn = new AbortController();
    session.turn = turn;
    try {
      return await prompt(session, blocks, turn.signal);
    } catch (error) {
      if (error instanceof Cancelled || turn.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      session.turn = null;
    }
  }

  /** T3's Stop sends session/cancel; it stops the cloud agent, not only the turn. */
  async function cancel(/** @type {Session} */ session) {
    session.turn?.abort();
    if (session.agentId === null) return;
    note(session, `Stopping cloud agent ${session.agentId}.\n`);
    try {
      await client.stop(session.agentId);
    } catch (error) {
      process.stderr.write(`cloud-agent-acp stop failed: ${/** @type {Error} */ (error).message}\n`);
    }
  }

  return {
    /** @param {string} method @param {any} params */
    async onRequest(method, params) {
      switch (method) {
        case "initialize":
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: true },
            },
            authMethods: [],
            agentInfo: { name: "cloud-agent-acp", title: "Cloud agent", version: VERSION },
          };
        case "session/new": {
          /** @type {Session} */
          const session = {
            id: `cas-${randomUUID()}`,
            cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
            modelId: config.defaultModel,
            agentId: null,
            stream: initialStreamState(),
            turn: null,
          };
          sessions.set(session.id, session);
          store.save(session);
          return { sessionId: session.id, models: models(session.modelId) };
        }
        case "session/load": {
          const id = String(params.sessionId);
          const record = store.load(id);
          if (!record) throw new RpcError(-32602, `Unknown session ${id}`);
          sessions.set(id, { ...record, id, turn: null });
          return { models: models(record.modelId) };
        }
        case "session/set_model": {
          const session = sessionOf(String(params.sessionId));
          modelFields(String(params.modelId));
          session.modelId = String(params.modelId);
          store.save(session);
          return {};
        }
        case "session/prompt":
          return runTurn(sessionOf(String(params.sessionId)), params.prompt ?? []);
        case "session/close":
          sessions.get(String(params.sessionId))?.turn?.abort();
          sessions.delete(String(params.sessionId));
          return {};
        case "authenticate":
        case "session/set_mode":
          return {};
        default:
          throw new RpcError(-32601, `Method not found: ${method}`);
      }
    },
    /** @param {string} method @param {any} params */
    onNotification(method, params) {
      if (method !== "session/cancel") return;
      const session = sessions.get(String(params.sessionId));
      if (session) void cancel(session);
    },
  };
}
