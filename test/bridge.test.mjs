// @ts-check
// Drives the bridge process over stdio the way T3's ACP adapter does, against the fake Backstage.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
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
    async open() {
      await this.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
      return /** @type {string} */ ((await this.request("session/new", { cwd: project, mcpServers: [] })).sessionId);
    },
    stop: () => new Promise((resolve) => (child.once("exit", resolve), child.stdin.end())),
  };
}

/** @param {string} text */
const prompt = (text) => [{ type: "text", text: `<t3_code_instructions>\nmode\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>\n\n<runtime_info>local</runtime_info>` }];

/** @param {any[]} updates */
const messageText = (updates) =>
  updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");

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

test("after a restart, session/load resumes the stream without repeating items", async () => {
  const first = startBridge();
  const sessionId = await first.open();
  void first.request("session/prompt", { sessionId, prompt: prompt("scenario: success\nRestart me") }).catch(() => {});
  await first.until(() => first.updates.filter((u) => u.sessionUpdate === "tool_call").length >= 3);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));

  const second = startBridge();
  await second.request("initialize", { protocolVersion: 1 });
  await second.request("session/load", { sessionId, cwd: project, mcpServers: [] });
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
  await second.stop();
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
