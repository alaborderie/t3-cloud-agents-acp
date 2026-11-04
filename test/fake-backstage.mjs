#!/usr/bin/env node
// @ts-check
// A fake of the Backstage cloud-agents API v1 that replays recorded runner streams.
//
// Each agent's first run replays opencode-needs-input.jsonl (one blocking question), and the
// run after the answer replays the harness's success stream, which ends with a PR URL. A
// brief that contains "scenario: success" skips the question. POST /stop cancels the run
// being replayed. Every request is printed as one JSON line, without the Authorization header.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { parseArgs } from "node:util";

const STREAMS = new URL("./fixtures/streams/", import.meta.url);
const TIER_HARNESS = /** @type {Record<string, string>} */ ({ flash: "opencode", sol: "codex", opus: "claude" });
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);
const RUN_STATUS_TO_AGENT = /** @type {Record<string, string>} */ ({
  succeeded: "succeeded",
  failed: "failed",
  needs_input: "needs_input",
  cancelled: "stopped",
});

/** @param {string} name @returns {any[]} */
const loadStream = (name) =>
  fs
    .readFileSync(new URL(`${name}.jsonl`, STREAMS), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/**
 * @typedef {{ method: string, path: string, body: any }} RecordedRequest
 * @typedef {{ port?: number, paceMs?: number, token?: string, onRequest?: (request: RecordedRequest) => void }} FakeOptions
 */

/** @param {FakeOptions} [options] */
export async function startFakeBackstage(options = {}) {
  const paceMs = options.paceMs ?? 300;
  const token = options.token ?? "cat_fake";
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Map<string, any>} */
  const agents = new Map();
  let nextAgent = 1;

  /** @param {any} agent @param {any} event */
  function publish(agent, event) {
    const envelope = { seq: agent.events.length + 1, runId: agent.activeRun?.id ?? agent.runs.at(-1)?.id ?? null, event };
    agent.events.push(envelope);
    agent.updatedAt = new Date().toISOString();
    for (const listener of agent.listeners) listener(envelope);
  }

  /** @param {any} agent @param {string} status */
  function setStatus(agent, status) {
    agent.status = status;
    publish(agent, { type: "agent.status", status });
  }

  /** @param {any} agent @param {string} streamName @param {"initial" | "reply" | "message"} reason */
  function startRun(agent, streamName, reason) {
    /** @type {any} */
    const run = { id: randomUUID(), status: "running", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null };
    agent.runs.push(run);
    agent.activeRun = run;
    agent.openQuestions = [];
    publish(agent, { type: "agent.run_started", runId: run.id, reason });
    setStatus(agent, "running");
    const lines = loadStream(streamName);
    /** @type {Map<string, any>} */
    const questions = new Map();
    let index = 0;
    const tick = () => {
      if (agent.activeRun !== run) return;
      const raw = lines[index++];
      if (!raw) return;
      const event = { ...raw, run_id: run.id };
      for (const key of ["repo", "branch"]) if (key in event) event[key] = agent[key];
      if (event.type === "question") questions.set(event.question_id, event);
      publish(agent, event);
      if (event.type === "run.finished") {
        finishRun(agent, run, event, questions);
        return;
      }
      run.timer = setTimeout(tick, paceMs);
    };
    run.timer = setTimeout(tick, paceMs);
  }

  /** @param {any} agent @param {any} run @param {any} finished @param {Map<string, any>} questions */
  function finishRun(agent, run, finished, questions) {
    run.status = finished.status === "cancelled" ? "stopped" : finished.status;
    run.finishedAt = new Date().toISOString();
    run.exitCode = finished.exit_code;
    agent.activeRun = null;
    if (finished.pr_url) agent.prUrl = finished.pr_url;
    agent.openQuestions = (finished.open_questions ?? []).map((/** @type {string} */ id) => ({
      questionId: id,
      runId: run.id,
      question: questions.get(id)?.question ?? id,
      options: (questions.get(id)?.options ?? []).map((/** @type {any} */ o) => o.label),
    }));
    agent.answers = new Map();
    setStatus(agent, RUN_STATUS_TO_AGENT[finished.status] ?? "failed");
    if (TERMINAL.has(agent.status)) for (const close of agent.closers) close();
  }

  /** @param {any} agent */
  const view = (agent) => ({
    id: agent.id,
    title: agent.title,
    repo: agent.repo,
    base: agent.base,
    branch: agent.branch,
    harness: agent.harness,
    model: agent.model,
    effort: agent.effort,
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    runs: agent.runs.map((/** @type {any} */ r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode })),
    openQuestions: agent.openQuestions,
    prUrl: agent.prUrl,
    parent: agent.parent,
  });

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} [body] */
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  /** @param {any} agent @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} url */
  function streamEvents(agent, req, res, url) {
    const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (/** @type {any} */ envelope) =>
      res.write(`id: ${envelope.seq}\nevent: agent-event\ndata: ${JSON.stringify(envelope)}\n\n`);
    for (const envelope of agent.events) if (envelope.seq > after) write(envelope);
    if (TERMINAL.has(agent.status)) return res.end();
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    const close = () => {
      clearInterval(ping);
      agent.listeners.delete(write);
      agent.closers.delete(close);
      res.end();
    };
    agent.listeners.add(write);
    agent.closers.add(close);
    req.on("close", close);
  }

  /** @param {any} body */
  function createAgent(body) {
    const harness = body.harness ?? TIER_HARNESS[body.tier ?? "flash"];
    if (!harness) return null;
    const id = `ag_${String(nextAgent++).padStart(4, "0")}`;
    const now = new Date().toISOString();
    const agent = {
      id,
      title: body.title ?? body.prompt.split("\n")[0].slice(0, 80),
      repo: body.repo,
      base: body.base,
      branch: body.branch ?? `cloud-agent/${id.slice(3)}`,
      harness,
      model: body.model ?? `${body.tier ?? "flash"}-default`,
      effort: body.effort ?? "high",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      runs: [],
      openQuestions: [],
      prUrl: null,
      parent: body.parent ?? null,
      events: [],
      listeners: new Set(),
      closers: new Set(),
      activeRun: null,
      answers: new Map(),
    };
    agents.set(id, agent);
    startRun(agent, /scenario:\s*success/i.test(body.prompt) ? harness : "opencode-needs-input", "initial");
    return agent;
  }

  /** @param {http.IncomingMessage} req */
  const readBody = async (req) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : undefined;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const recorded = { method: req.method ?? "GET", path: url.pathname + url.search, body: body ?? null };
    requests.push(recorded);
    options.onRequest?.(recorded);
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });

    const route = url.pathname.replace(/^\/api\/cloud-agents/, "");
    const match = route.match(/^\/agents\/([^/]+)(?:\/(events|reply|messages|stop))?$/);
    const agent = match ? agents.get(decodeURIComponent(match[1])) : undefined;

    if (req.method === "POST" && route === "/agents") {
      if (!body?.repo || !body?.prompt) return send(res, 400, { error: "repo and prompt are required" });
      const created = createAgent(body);
      return created ? send(res, 201, view(created)) : send(res, 400, { error: "unknown tier" });
    }
    if (req.method === "GET" && route === "/agents") {
      const status = url.searchParams.get("status");
      const list = [...agents.values()].reverse().filter((a) => !status || a.status === status);
      return send(res, 200, list.map(view));
    }
    if (!match || !agent) return send(res, 404, { error: "not_found" });
    const action = match[2];
    if (req.method === "GET" && !action) return send(res, 200, view(agent));
    if (req.method === "GET" && action === "events") return streamEvents(agent, req, res, url);
    if (req.method === "POST" && action === "reply") {
      const question = agent.openQuestions.find((/** @type {any} */ q) => q.questionId === body?.questionId);
      if (agent.status !== "needs_input" || !question) return send(res, 409, { error: "no_such_open_question" });
      agent.answers.set(question.questionId, String(body.answer));
      send(res, 202);
      if (agent.openQuestions.every((/** @type {any} */ q) => agent.answers.has(q.questionId))) {
        startRun(agent, agent.harness, "reply");
      }
      return;
    }
    if (req.method === "POST" && action === "messages") {
      if (agent.activeRun) return send(res, 409, { error: "run_active" });
      send(res, 202);
      return startRun(agent, agent.harness, "message");
    }
    if (req.method === "POST" && action === "stop") {
      send(res, 202);
      const run = agent.activeRun;
      if (run) {
        clearTimeout(run.timer);
        const cancelled = loadStream("opencode-cancelled").at(-1);
        const event = { ...cancelled, run_id: run.id, branch: agent.branch, ts: new Date().toISOString() };
        publish(agent, event);
        return finishRun(agent, run, event, new Map());
      }
      if (!TERMINAL.has(agent.status)) {
        agent.openQuestions = [];
        setStatus(agent, "stopped");
        for (const close of agent.closers) close();
      }
      return;
    }
    return send(res, 405, { error: "method_not_allowed" });
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const agent of agents.values()) {
          clearTimeout(agent.activeRun?.timer);
          for (const close of agent.closers) close();
        }
        server.close(() => resolve(undefined));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "7480" }, pace: { type: "string", default: "400" }, token: { type: "string", default: "cat_fake" } },
  });
  const fake = await startFakeBackstage({
    port: Number(values.port),
    paceMs: Number(values.pace),
    token: values.token,
    onRequest: (request) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...request })}\n`),
  });
  process.stderr.write(`fake Backstage listening on ${fake.url} (token ${fake.token})\n`);
}
