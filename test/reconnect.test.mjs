// @ts-check
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createBridge } from "../src/bridge.mjs";

for (const disconnect of ["eof", "error"]) {
  test(`reconnect survives a failed status fetch after stream ${disconnect}`, async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reconnect-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const agent = { id: "ag_reconnect", status: "running", branch: "cloud-agent/reconnect" };
    let streams = 0;
    let reads = 0;
    /** @type {number[]} */
    const cursors = [];
    /** @type {any[]} */
    const updates = [];
    const bridge = createBridge({
      config: { backstageUrl: "", token: "", stateDir, repo: "alaborderie/cloud-agent-runner-sandbox", base: "main", defaultModel: "sol", models: [{ id: "sol", name: "Sol", tier: "sol" }] },
      client: /** @type {any} */ ({
        createAgent: async () => agent,
        getAgent: async () => {
          if (++reads === 1) throw new TypeError("fetch failed during Backstage restart");
          return agent;
        },
        async *events(/** @type {string} */ id, /** @type {number} */ after) {
          cursors.push(after);
          if (++streams === 1) {
            yield { seq: 1, runId: "run-1", event: { type: "assistant.message", text: "Before restart" } };
            if (disconnect === "error") throw new TypeError("terminated");
            return;
          }
          if (disconnect === "error" && streams === 2) return;
          yield { seq: 2, runId: "run-1", event: { type: "agent.status", status: "waiting", futureField: true } };
          yield { seq: 3, runId: "run-1", event: { type: "agent.wake", childId: "ag_child" } };
          yield { seq: 4, runId: "run-1", event: { type: "assistant.message", text: "After restart" } };
          agent.status = "succeeded";
          yield { seq: 5, runId: "run-1", event: { type: "agent.status", status: "succeeded" } };
        },
      }),
      acp: () => /** @type {any} */ ({ notify: (/** @type {string} */ method, /** @type {any} */ params) => updates.push(params.update) }),
    });
    const { sessionId } = /** @type {any} */ (await bridge.onRequest("session/new", { cwd: stateDir }));
    assert.deepEqual(await bridge.onRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reconnect proof" }] }), { stopReason: "end_turn" });
    assert.ok(cursors.length >= 2);
    assert.ok(cursors.slice(1).every((cursor) => cursor === 1), "reconnect starts after the persisted event");
    const text = updates.map((u) => u.content?.text ?? "").join("");
    assert.equal(text.match(/Before restart/g)?.length, 1);
    assert.equal(text.match(/After restart/g)?.length, 1);
    assert.match(text, /ag_reconnect succeeded/);
  });
}
