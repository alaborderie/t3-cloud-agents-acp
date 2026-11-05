// @ts-check
// Drives the bridge process over stdio the way T3's ACP adapter does, against the fake Backstage.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { after, before, test } from "node:test";

import { startFakeBackstage } from "./fake-backstage.mjs";

const MAIN = new URL("../src/main.mjs", import.meta.url).pathname;
const SANDBOX = "alaborderie/cloud-agent-runner-sandbox";

/** @type {Awaited<ReturnType<typeof startFakeBackstage>>} */
let fake;
let tmp = "";
let configFile = "";
let project = "";

before(async () => {
  fake = await startFakeBackstage({ paceMs: 5 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-agent-acp-"));
  project = path.join(tmp, "project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "remote", "add", "origin", `git@github.com:${SANDBOX}.git`]);
  fs.writeFileSync(path.join(tmp, "token"), `${fake.token}\n`);
  configFile = path.join(tmp, "config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ backstageUrl: fake.url, tokenFile: path.join(tmp, "token"), stateDir: path.join(tmp, "state") }),
  );
});

after(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A fake of T3's MCP endpoint that records each tool call. `failing` makes every tool call fail.
 * `servers` is the mcpServers entry T3 sends a local ACP command.
 */
async function startFakeT3Mcp() {
  const authorization = "Bearer t3-fake";
  /** @type {{ name: string, arguments: any, authorization: string | undefined }[]} */
  const calls = [];
  const state = { failing: false };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) return void res.writeHead(202).end();
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-t3", version: "1" } };
    if (message.method === "tools/call") {
      calls.push({ name: message.params.name, arguments: message.params.arguments, authorization: req.headers.authorization });
      result = state.failing
        ? { isError: true, content: [{ type: "text", text: "This is not a recognised pull request URL." }] }
        : { content: [{ type: "text", text: "{}" }], structuredContent: { alreadyLinked: false } };
    }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "mcp-1" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/mcp`;
  return {
    calls,
    state,
    authorization,
    servers: [{ name: "t3", command: "t3", args: ["acp-mcp-bridge"], env: [{ name: "T3_ACP_MCP_ENDPOINT", value: url }, { name: "T3_ACP_MCP_AUTHORIZATION", value: authorization }] }],
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

/**
 * A minimal ACP client. `onElicit` answers elicitation/create requests.
 * @param {{ onElicit?: (params: any) => any }} [options]
 */
function startBridge(options = {}) {
  const child = spawn(process.execPath, [MAIN, "--config", configFile], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  /** @type {any[]} */
  const updates = [];
  /** @type {any[]} */
  const elicitations = [];
  /** @type {Map<number, (message: any) => void>} */
  const waiters = new Map();
  let nextId = 1;
  const send = (/** @type {any} */ message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "session/update") updates.push(message.params.update);
    else if (message.method === "elicitation/create") {
      elicitations.push(message.params);
      const result = options.onElicit?.(message.params);
      if (result !== undefined) send({ id: message.id, result });
    } else if (message.id !== undefined) waiters.get(message.id)?.(message);
  });
  return {
    child,
    updates,
    elicitations,
    stderr: () => stderr,
    /** @param {string} method @param {any} params @returns {Promise<any>} */
    request(method, params) {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) =>
        waiters.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result))),
      );
    },
    /** @param {string} method @param {any} params */
    notify: (method, params) => send({ method, params }),
    /** Resolves once `predicate` holds; it also polls, since fake-server requests print nothing. @param {() => boolean} predicate */
    until(predicate) {
      return new Promise((resolve) => {
        const timer = setInterval(() => predicate() && (clearInterval(timer), resolve(undefined)), 20);
      });
    },
    async open(/** @type {unknown[]} */ mcpServers = []) {
      await this.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
      return /** @type {string} */ ((await this.request("session/new", { cwd: project, mcpServers })).sessionId);
    },
    stop: () => new Promise((resolve) => (child.once("exit", resolve), child.stdin.end())),
  };
}

/** @param {string} text */
const prompt = (text) => [{ type: "text", text: `<t3_code_instructions>\nmode\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>\n\n<runtime_info>local</runtime_info>` }];

/** @param {any[]} updates */
const messageText = (updates) =>
  updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");

const PR_URL = `https://github.com/${SANDBOX}/pull/3`;

/** @param {string} agentId */
const requestsFor = (agentId) => fake.requests.filter((r) => r.path.includes(`/agents/${agentId}`) && r.method === "POST");

const agentIdOf = (/** @type {any[]} */ updates) =>
  /** @type {string} */ (updates.map((u) => u.content?.text?.match(/Cloud agent (ag_\d+) created/)?.[1]).find(Boolean));

test("a question reaches T3, the answer goes to /reply, and the final message has the PR URL", async () => {
  const bridge = startBridge({ onElicit: () => ({ action: "accept", content: { "ask-1": "no" } }) });
  const sessionId = await bridge.open();
  const result = await bridge.request("session/prompt", { sessionId, prompt: prompt("Ask before deleting README.md") });
  assert.deepEqual(result, { stopReason: "end_turn" });

  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/api/cloud-agents/agents" && r.body.prompt === "Ask before deleting README.md");
  assert.ok(create, "the brief is the user request without T3's blocks");
  assert.equal(create.body.repo, SANDBOX, "the repo comes from the folder's origin remote");
  assert.equal(create.body.tier, "flash");
  assert.deepEqual(create.body.parent, { source: "t3", label: sessionId });

  assert.equal(bridge.elicitations.length, 1);
  const schema = bridge.elicitations[0].requestedSchema;
  assert.deepEqual(Object.keys(schema.properties), ["ask-1"]);
  assert.equal(schema.properties["ask-1"].description, "Should I delete README.md?");
  assert.deepEqual(schema.properties["ask-1"].enum, ["yes", "no"]);

  const agentId = agentIdOf(bridge.updates);
  assert.deepEqual(
    requestsFor(agentId).map((r) => [r.path, r.body]),
    [[`/api/cloud-agents/agents/${agentId}/reply`, { questionId: "ask-1", answer: "no" }]],
  );
  assert.ok(bridge.updates.some((u) => u.sessionUpdate === "tool_call" && u.kind === "edit"), "tool items stream");
  assert.match(messageText(bridge.updates), /PR: https:\/\/github\.com\/alaborderie\/cloud-agent-runner-sandbox\/pull\/3$/);
  await bridge.stop();
});

test("Stop sends POST /stop and ends the turn as cancelled", async () => {
  const bridge = startBridge();
  const sessionId = await bridge.open();
  const turn = bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nWrite hello") });
  await bridge.until(() => bridge.updates.some((u) => u.sessionUpdate === "tool_call"));
  bridge.notify("session/cancel", { sessionId });
  assert.deepEqual(await turn, { stopReason: "cancelled" });
  const agentId = agentIdOf(bridge.updates);
  await bridge.until(() => requestsFor(agentId).length > 0);
  assert.deepEqual(requestsFor(agentId).map((r) => r.path), [`/api/cloud-agents/agents/${agentId}/stop`]);
  await bridge.stop();
});

test("Stop while the question is open also stops the agent", async () => {
  const bridge = startBridge();
  const sessionId = await bridge.open();
  const turn = bridge.request("session/prompt", { sessionId, prompt: prompt("Ask first") });
  await bridge.until(() => bridge.elicitations.length === 1);
  bridge.notify("session/cancel", { sessionId });
  assert.deepEqual(await turn, { stopReason: "cancelled" });
  const agentId = agentIdOf(bridge.updates);
  await bridge.until(() => requestsFor(agentId).length > 0);
  assert.deepEqual(requestsFor(agentId).map((r) => r.path), [`/api/cloud-agents/agents/${agentId}/stop`]);
  await bridge.stop();
});

test("Stop before Backstage answers POST /agents stops the agent it creates", { timeout: 5_000 }, async () => {
  fake.control.createDelayMs = 300;
  const bridge = startBridge();
  try {
    const sessionId = await bridge.open();
    const turn = bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nSlow create") });
    await bridge.until(() => fake.requests.some((r) => r.body?.prompt === "scenario: success\nSlow create"));
    bridge.notify("session/cancel", { sessionId });
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    const [agent] = await (await fetch(`${fake.url}/api/cloud-agents/agents`, { headers: { authorization: `Bearer ${fake.token}` } })).json();
    await bridge.until(() => requestsFor(agent.id).length > 0);
    assert.deepEqual(requestsFor(agent.id).map((r) => r.path), [`/api/cloud-agents/agents/${agent.id}/stop`]);
  } finally {
    fake.control.createDelayMs = 0;
    await bridge.stop();
  }
});

test("after a restart, session/load resumes the stream without repeating items", async (t) => {
  const first = startBridge();
  const sessionId = await first.open();
  void first.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nRestart me") }).catch(() => {});
  await first.until(() => first.updates.filter((u) => u.sessionUpdate === "tool_call").length >= 3);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));

  const t3 = await startFakeT3Mcp();
  t.after(t3.close);
  const second = startBridge();
  t.after(second.stop);
  await second.request("initialize", { protocolVersion: 1 });
  await second.request("session/load", { sessionId, cwd: project, mcpServers: t3.servers });
  const result = await second.request("session/prompt", {
    sessionId,
    prompt: prompt("Continue where you left off. Your last turn was cut short."),
  });
  assert.deepEqual(result, { stopReason: "end_turn" });
  const items = [...first.updates, ...second.updates].filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId);
  assert.equal(new Set(items).size, items.length, "no tool item is shown twice");
  assert.equal(items.length, 7, "every tool call of the opencode stream is shown once");
  assert.match(messageText(second.updates), /PR: https:\/\/github\.com\/alaborderie\/cloud-agent-runner-sandbox\/pull\/3$/);
  const agentId = agentIdOf(first.updates);
  assert.equal(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/cloud-agents/agents" && r.body.prompt === "scenario: success\nRestart me").length, 1, "one agent");
  assert.deepEqual(requestsFor(agentId), [], "the restart sends nothing to the agent");
  assert.deepEqual(t3.calls.map((c) => [c.name, c.arguments]), [["link_pull_request", { url: PR_URL }]], "session/load's MCP server links the PR");
});

test("a follow-up message on a finished agent goes to /messages", async () => {
  const bridge = startBridge();
  const sessionId = await bridge.open();
  await bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nWrite hello") });
  const agentId = agentIdOf(bridge.updates);
  const result = await bridge.request("session/prompt", { sessionId, prompt: prompt("Also add a newline") });
  assert.deepEqual(result, { stopReason: "end_turn" });
  assert.deepEqual(requestsFor(agentId).map((r) => [r.path, r.body]), [[`/api/cloud-agents/agents/${agentId}/messages`, { text: "Also add a newline" }]]);
  const finals = bridge.updates.filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.startsWith("Cloud agent"));
  assert.equal(finals.length, 2, "each turn ends with its own final message");
  await bridge.stop();
});

test("the brief's repo and model lines win over the folder and the default tier", async () => {
  const bridge = startBridge();
  const sessionId = await bridge.open();
  await bridge.request("session/set_model", { sessionId, modelId: "opus" });
  await bridge.request("session/prompt", { sessionId, prompt: prompt("repo: someone/else\nbase: develop\nscenario: success\nDo it") });
  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/api/cloud-agents/agents" && r.body.repo === "someone/else");
  assert.ok(create);
  assert.equal(create.body.base, "develop");
  assert.equal(create.body.tier, "opus");
  assert.equal(create.body.prompt, "scenario: success\nDo it");
  await bridge.stop();
});

test("the token stays out of the bridge's output", async () => {
  const bridge = startBridge();
  const sessionId = await bridge.open();
  await bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nWrite hello") });
  await bridge.stop();
  assert.ok(!JSON.stringify(bridge.updates).includes(fake.token));
  assert.ok(!bridge.stderr().includes(fake.token));
});

test("a run that ends with a PR links it to the T3 thread once, across follow-up runs", async (t) => {
  const t3 = await startFakeT3Mcp();
  t.after(t3.close);
  const bridge = startBridge();
  t.after(bridge.stop);
  const sessionId = await bridge.open(t3.servers);
  await bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nOpen a PR") });
  assert.deepEqual(t3.calls, [{ name: "link_pull_request", arguments: { url: PR_URL }, authorization: t3.authorization }]);
  assert.equal(bridge.updates.at(-1).content.text.split("\n").at(-1), `PR: ${PR_URL}`, "the summary stays the last update");

  await bridge.request("session/prompt", { sessionId, prompt: prompt("Also add a newline") });
  assert.match(messageText(bridge.updates), /PR: .*pull\/3[^]*PR: .*pull\/3$/, "the follow-up run ends with the same PR");
  assert.equal(t3.calls.length, 1, "the same PR is not linked again");
});

test("a failed link leaves the run's result intact and is retried on the next run", async (t) => {
  const t3 = await startFakeT3Mcp();
  t.after(t3.close);
  t3.state.failing = true;
  const bridge = startBridge();
  t.after(bridge.stop);
  const sessionId = await bridge.open(t3.servers);
  const result = await bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nOpen a PR") });
  assert.deepEqual(result, { stopReason: "end_turn" });
  assert.match(messageText(bridge.updates), /PR: .*pull\/3$/);
  assert.match(bridge.stderr(), /could not link .*pull\/3 in T3: T3 MCP link_pull_request: This is not a recognised/);

  t3.state.failing = false;
  await bridge.request("session/prompt", { sessionId, prompt: prompt("Try again") });
  assert.deepEqual(t3.calls.map((c) => c.name), ["link_pull_request", "link_pull_request"]);
});

test("an unreachable T3 MCP endpoint does not fail the run", async (t) => {
  const bridge = startBridge();
  t.after(bridge.stop);
  const servers = [{ name: "t3", command: "t3", args: [], env: [{ name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:9/mcp" }, { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer x" }] }];
  const sessionId = await bridge.open(servers);
  const result = await bridge.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nOpen a PR") });
  assert.deepEqual(result, { stopReason: "end_turn" });
  assert.match(messageText(bridge.updates), /PR: .*pull\/3$/);
  assert.match(bridge.stderr(), /could not link/);
});

test("a top-level prompt answers a dismissed question and continues after ACP reload on the same agent", async (t) => {
  const first = startBridge({ onElicit: () => ({ action: "cancel" }) });
  t.after(first.stop);
  const sessionId = await first.open();
  const topLevel = (/** @type {string} */ text) => [
    { type: "text", text: "<t3_code_instructions>Local tools</t3_code_instructions>" },
    { type: "text", text },
    { type: "text", text: "<runtime_info>Jarvis</runtime_info>\n<pull_request_linking>Link PRs</pull_request_linking>" },
  ];
  await first.request("session/prompt", { sessionId, prompt: topLevel("Ask which proof label to use") });
  const agentId = agentIdOf(first.updates);
  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/api/cloud-agents/agents" && r.body.prompt === "Ask which proof label to use");
  assert.ok(create);
  assert.equal(create.body.repo, SANDBOX);
  assert.equal(create.body.title, "Ask which proof label to use");
  assert.equal(first.elicitations.length, 1);
  await first.request("session/prompt", { sessionId, prompt: topLevel("Top-level ACP proof") });

  const second = startBridge();
  t.after(second.stop);
  await second.request("initialize", { protocolVersion: 1 });
  await second.request("session/load", { sessionId, cwd: project });
  await second.request("session/prompt", { sessionId, prompt: topLevel("Add the follow-up proof") });
  assert.deepEqual(requestsFor(agentId).map((r) => [r.path, r.body]), [
    [`/api/cloud-agents/agents/${agentId}/reply`, { questionId: "ask-1", answer: "Top-level ACP proof" }],
    [`/api/cloud-agents/agents/${agentId}/messages`, { text: "Add the follow-up proof" }],
  ]);
  assert.match(messageText(second.updates), new RegExp(`Cloud agent ${agentId} succeeded`));
});
