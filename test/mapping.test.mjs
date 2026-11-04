// @ts-check
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { finalSummary, initialStreamState, step } from "../src/mapping.mjs";

const STREAMS = ["claude", "codex", "opencode", "opencode-needs-input", "opencode-cancelled"];

/** @param {string} name */
const fixture = (name) =>
  fs
    .readFileSync(new URL(`./fixtures/streams/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Wraps a runner stream the way the plugin does, ending with the agent status. */
function envelopes(/** @type {string} */ name, firstSeq = 1, runId = "run-1") {
  const events = fixture(name);
  const finished = events.at(-1);
  const agentStatus = { needs_input: "needs_input", cancelled: "stopped" }[/** @type {string} */ (finished.status)] ?? finished.status;
  return [
    { type: "agent.run_started", runId, reason: "initial" },
    ...events,
    { type: "agent.status", status: agentStatus },
  ].map((event, index) => ({ seq: firstSeq + index, runId, event }));
}

/** @param {any[]} list */
function run(list, state = initialStreamState()) {
  const updates = [];
  const signals = [];
  for (const envelope of list) {
    const result = step(state, envelope);
    state = result.state;
    updates.push(...result.updates);
    if (result.signal) signals.push(result.signal);
  }
  return { state, updates, signals };
}

for (const name of STREAMS) {
  test(`${name}: every tool call gets one tool item that its result completes`, () => {
    const events = fixture(name);
    const { updates } = run(envelopes(name));
    const calls = events.filter((e) => e.type === "tool.call");
    const results = events.filter((e) => e.type === "tool.result");
    const items = updates.filter((u) => u.sessionUpdate === "tool_call");
    const itemUpdates = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    assert.equal(items.length, calls.length);
    assert.equal(itemUpdates.length, results.length);
    for (const result of results) {
      const update = itemUpdates.find((u) => u.toolCallId === `run-1:${result.call_id}`);
      assert.ok(update, `result ${result.call_id} updates its item`);
      assert.equal(update.status, result.is_error ? "failed" : "completed");
      assert.ok(items.some((item) => item.toolCallId === update.toolCallId), `item ${result.call_id} exists`);
    }
  });

  test(`${name}: assistant text streams as message chunks, in order`, () => {
    const texts = fixture(name).filter((e) => e.type === "assistant.message" && !e.parent_call_id).map((e) => e.text.trim());
    const { updates } = run(envelopes(name));
    const chunks = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => /** @type {any} */ (u).content.text.trim());
    assert.deepEqual(chunks, texts);
  });
}

test("a shell call becomes an execute item titled with its command", () => {
  const { updates } = run(envelopes("claude"));
  const bash = /** @type {any} */ (updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "execute"));
  assert.match(bash.title, /^echo "hello from claude" > hello-claude\.txt/);
  assert.equal(bash.status, "in_progress");
});

test("the same call id in two runs gives two tool items", () => {
  const first = run(envelopes("codex", 1, "run-a"));
  const second = run(envelopes("codex", 100, "run-b"), first.state);
  const ids = [...first.updates, ...second.updates].filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId);
  assert.equal(new Set(ids).size, ids.length);
});

test("a blocking question waits for the agent status; a non-blocking one is a note", () => {
  const { updates, signals } = run(envelopes("opencode-needs-input"));
  assert.deepEqual(signals, [{ type: "needs_input" }]);
  const notes = updates.filter((u) => u.sessionUpdate === "agent_thought_chunk").map((u) => /** @type {any} */ (u).content.text);
  assert.ok(notes.some((text) => text.startsWith("Question (the agent continues with its default): Should I delete README.md?")));
  assert.equal(notes.filter((text) => text.includes("Should I delete README.md?")).length, 1, "the blocking ask-1 is not a note");
});

test("a terminal agent status ends the stream with that status", () => {
  assert.deepEqual(run(envelopes("opencode")).signals, [{ type: "terminal", status: "succeeded" }]);
  assert.deepEqual(run(envelopes("opencode-cancelled")).signals, [{ type: "terminal", status: "stopped" }]);
});

test("usage accumulates cost and reports the last step's tokens", () => {
  const { updates } = run(envelopes("claude"));
  const usage = /** @type {any} */ (updates.find((u) => u.sessionUpdate === "usage_update"));
  assert.equal(usage.used, 122137 + 590);
  assert.deepEqual(usage.cost, { amount: 0.1430238, currency: "USD" });
});

test("a harness error log becomes a note", () => {
  const { updates } = run(envelopes("opencode-cancelled"));
  assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk" && /** @type {any} */ (u).content.text.startsWith("[harness error] Transport: ECONNRESET")));
});

test("envelopes at or below the last seen seq produce nothing", () => {
  const list = envelopes("opencode");
  const { state } = run(list.slice(0, 10));
  const replay = run(list, state);
  const fresh = run(list.slice(10), state);
  assert.deepEqual(replay.updates, fresh.updates);
  assert.equal(replay.state.lastSeq, list.at(-1)?.seq);
});

test("the final message carries the status, branch and PR URL", () => {
  const { state } = run(envelopes("opencode"));
  const summary = /** @type {any} */ (finalSummary({ id: "ag_1", status: "succeeded", prUrl: null }, state.lastRun));
  assert.equal(summary.sessionUpdate, "agent_message_chunk");
  assert.equal(
    summary.content.text,
    "Cloud agent ag_1 succeeded.\nBranch: test/opencode-20261104-132736\nPR: https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/3",
  );
});

test("a cancelled run's final message gives the error", () => {
  const { state } = run(envelopes("opencode-cancelled"));
  const summary = /** @type {any} */ (finalSummary({ id: "ag_2", status: "stopped" }, state.lastRun));
  assert.match(summary.content.text, /^Cloud agent ag_2 stopped\.\nBranch: test\/opencode-20261104-133323\nPR: none\nError: /);
});
