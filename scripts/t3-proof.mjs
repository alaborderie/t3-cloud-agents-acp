#!/usr/bin/env node
// @ts-check
// Proves the bridge on an official T3 release in a throwaway T3 home, against the fake
// Backstage: a parent thread delegates to the bridge, answers its question, lists the PRs
// linked to the child, and stops a second cloud agent. Each check prints PASS or FAIL; the
// exit code is the number of FAILs.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    home: { type: "string", default: path.join(os.homedir(), "t3-acp-proof") },
    version: { type: "string", default: "0.1.7" },
    port: { type: "string", default: "47811" },
    "fake-port": { type: "string", default: "7480" },
    keep: { type: "boolean", default: false },
  },
});
const HOME = path.resolve(/** @type {string} */ (opts.home));
if (HOME === path.join(os.homedir(), ".t3")) throw new Error("Refusing to use the live T3 home ~/.t3");
const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const T3 = path.join(HOME, "bin", "t3");
const BASE = `http://127.0.0.1:${opts.port}`;
const FAKE = `http://127.0.0.1:${opts["fake-port"]}`;
const BRIDGE_DIR = path.join(HOME, "bridge");
const REQUESTS = path.join(BRIDGE_DIR, "fake-requests.jsonl");
const PROJECT = path.join(HOME, "project");
const SANDBOX = "alaborderie/cloud-agent-runner-sandbox";
const PR_URL = `https://github.com/${SANDBOX}/pull/3`;

const EVIDENCE = path.join(HOME, "evidence", new Date().toISOString().replace(/[:.]/g, "-"));
/** @type {string[]} */
const transcript = [];
/** @param {string} line */
const log = (line) => (transcript.push(line), console.log(line));

let failures = 0;
/** @param {boolean} ok @param {string} label @param {unknown} [evidence] */
function check(ok, label, evidence) {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"} ${label}${evidence === undefined ? "" : `\n     ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`}`);
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {string[]} args */
const t3 = (args) => execFileSync(T3, [...args.slice(0, 2), "--base-dir", HOME, ...args.slice(2)], { encoding: "utf8", cwd: PROJECT, maxBuffer: 64 << 20 });
/** Each row's columns joined by "|", one row per line, like the sqlite3 CLI. @param {string} query */
function sql(query) {
  const db = new DatabaseSync(path.join(HOME, "userdata", "statev2.sqlite"), { readOnly: true });
  try {
    return db.prepare(query).all().map((row) => Object.values(row).join("|")).join("\n");
  } finally {
    db.close();
  }
}
const fakeRequests = () =>
  fs.existsSync(REQUESTS) ? fs.readFileSync(REQUESTS, "utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)) : [];

/** @template T @param {() => T | undefined | null | false} probe @param {string} what */
async function waitFor(probe, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

function install() {
  if (fs.existsSync(T3) && execFileSync(T3, ["--version"], { encoding: "utf8" }).includes(`v${opts.version}`)) return;
  const script = execFileSync("curl", ["-fsSL", "https://t3.codes/install.sh"], { encoding: "utf8" });
  execFileSync("sh", ["-s"], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, T3CODE_VERSION: opts.version, T3CODE_HOME: HOME, T3CODE_INSTALL_BIN_DIR: path.join(HOME, "bin") },
  });
}

function configure() {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(BRIDGE_DIR, "token"), "cat_fake\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(BRIDGE_DIR, "config.json"),
    JSON.stringify({ backstageUrl: FAKE, tokenFile: path.join(BRIDGE_DIR, "token"), stateDir: path.join(BRIDGE_DIR, "state") }, null, 2),
  );
  const settingsFile = path.join(HOME, "userdata", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  settings.providerInstances = {
    ...settings.providerInstances,
    cloudAgent: {
      displayName: "Cloud agent",
      driver: "acpRegistry",
      config: { source: "local", commandPath: process.execPath, commandArgs: [path.join(REPO, "src/main.mjs"), "--config", path.join(BRIDGE_DIR, "config.json")] },
    },
    scriptedParent: {
      displayName: "Scripted parent",
      driver: "acpRegistry",
      config: { source: "local", commandPath: process.execPath, commandArgs: [path.join(REPO, "test/t3/scripted-parent.mjs")] },
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  if (!fs.existsSync(path.join(PROJECT, ".git"))) {
    fs.mkdirSync(PROJECT, { recursive: true });
    execFileSync("git", ["init", "-q", PROJECT]);
    execFileSync("git", ["-C", PROJECT, "remote", "add", "origin", `https://github.com/${SANDBOX}.git`]);
    execFileSync("git", ["-C", PROJECT, "-c", "user.name=proof", "-c", "user.email=proof@localhost", "commit", "-q", "--allow-empty", "-m", "init"]);
  }
}

/** @param {string} command @param {string[]} args @param {string} log */
function background(command, args, log, cwd = HOME) {
  const out = fs.openSync(log, "a");
  const child = spawn(command, args, { cwd, stdio: ["ignore", out, out], detached: true });
  child.unref();
  return child;
}

/** @param {string} parent @param {object} call */
const send = (parent, call) => t3(["thread", "send", parent, "--wait", JSON.stringify(call)]);

/** @param {string} parent @returns {string[]} */
const parentMessages = (parent) => JSON.parse(t3(["thread", "show", parent, "--json", "--messages", "40"])).messages.map((/** @type {any} */ m) => m.text ?? "");

/** @param {string} reply */
const delegated = (reply) => ({
  taskId: /** @type {string} */ (reply.match(/"taskId\\?":\\?"(node:delegated-task:[^"\\]+)/)?.[1]),
  childThreadId: /** @type {string} */ (reply.match(/"childThreadId\\?":\\?"(thread:delegated-task:[^"\\]+)/)?.[1]),
});

async function main() {
  install();
  configure();
  fs.rmSync(REQUESTS, { force: true });
  const fake = background(process.execPath, [path.join(REPO, "test/fake-backstage.mjs"), "--port", String(opts["fake-port"]), "--pace", "400"], REQUESTS, REPO);
  const server = background(T3, ["serve", "--base-dir", HOME, "--port", String(opts.port), "--host", "127.0.0.1", "--no-browser", PROJECT], path.join(HOME, "serve.log"));
  try {
    let env = null;
    for (let i = 0; i < 120 && !env; i++) {
      env = await fetch(`${BASE}/.well-known/t3/environment`).then((r) => r.json()).catch(() => null);
      if (!env) await sleep(500);
    }
    if (!env) throw new Error("The T3 server did not start; see serve.log");
    check(env.serverVersion === opts.version, `T3 server runs the official ${opts.version}`, { serverVersion: env.serverVersion });
    try {
      t3(["project", "add", PROJECT]);
    } catch {
      // Already added by an earlier run.
    }

    const task = "scenario: runner-pr\nAsk before deleting README.md, then open a PR.";
    const parent = t3(["thread", "start", PROJECT, "--provider", "scriptedParent", "--model", "script", "--title", "proof parent", "--wait", "--json",
      JSON.stringify({ tool: "delegate_task", args: { task, title: "[proof] cloud agent", target: { providerInstanceId: "cloudAgent", model: "flash" } } })]);
    const parentId = /** @type {string} */ (parent.match(/"threadId":"([^"]+)"/)?.[1]);
    const first = delegated(parent);
    check(Boolean(first.childThreadId), "delegate_task to the cloudAgent provider created a child thread", first);

    const lineage = sql(`select json_extract(payload_json,'$.lineage.parentThreadId') || ' ' || json_extract(payload_json,'$.lineage.relationshipToParent') from orchestration_v2_projection_threads where thread_id='${first.childThreadId}'`);
    check(lineage === `${parentId} subagent`, "the child is a subagent of the parent thread", lineage);
    const listed = JSON.parse(t3(["thread", "list", "--json"])).map((/** @type {any} */ t) => t.threadId);
    check(listed.includes(parentId) && !listed.includes(first.childThreadId), "the top-level thread list shows the parent and not the nested child");

    const created = await waitFor(() => fakeRequests().find((r) => r.method === "POST" && r.path === "/api/cloud-agents/agents" && r.body.prompt === task), "POST /agents");
    check(created.body.repo === SANDBOX && created.body.tier === "flash", "POST /agents uses the project's origin repo and the selected tier", created.body);
    const agentId = await waitFor(() => fakeRequests().find((r) => r.path.match(/^\/api\/cloud-agents\/agents\/ag_\d+\/events/))?.path.match(/ag_\d+/)?.[0], "the event stream");

    const wake = await waitFor(() => parentMessages(parentId).find((text) => text.includes("is blocked on a question") && text.includes(first.childThreadId)), "the question to wake the parent");
    const requestId = /** @type {string} */ (wake.match(/requestId (\S+)\. /)?.[1]);
    check(Boolean(requestId), "the cloud agent's question woke the parent thread", wake.slice(5, 140));
    const read = send(parentId, { tool: "t3_pending_request", args: { action: "read", threadId: first.childThreadId, requestId } });
    check(read.includes("Should I delete README.md?") && read.includes('"id":"ask-1"'), "the parent reads the question with its options", read.match(/"questions":\[.*?\]\}/)?.[0]);
    send(parentId, { tool: "t3_pending_request", args: { action: "respond", threadId: first.childThreadId, requestId, answers: { "ask-1": "yes" } } });
    const reply = await waitFor(() => fakeRequests().find((r) => r.method === "POST" && r.path === `/api/cloud-agents/agents/${agentId}/reply`), "POST /reply");
    check(JSON.stringify(reply.body) === JSON.stringify({ questionId: "ask-1", answer: "yes" }), `the answer reached POST /agents/${agentId}/reply`, reply.body);

    const result = await waitFor(() => parentMessages(parentId).find((text) => text.includes(first.taskId) && text.includes("[completed]")), "the result in the parent");
    check(result.includes(`PR: ${PR_URL}`), "the parent received the final message with the PR URL", result.slice(result.indexOf("[completed]"), result.indexOf("[completed]") + 200).split("<runtime_info>")[0]);
    send(parentId, { tool: "list_thread_pull_requests", args: { threadId: first.childThreadId } });
    const listedPrs = JSON.parse(parentMessages(parentId).findLast((text) => text.startsWith('{"content"') && text.includes("pullRequests")) ?? "null");
    const childPrs = JSON.parse(listedPrs?.content?.[0]?.text ?? "{}").pullRequests ?? [];
    check(childPrs.some((/** @type {any} */ pr) => pr.url === PR_URL), "T3 lists the cloud agent's PR on the child thread (list_thread_pull_requests)", childPrs);
    const items = sql(`select type || ':' || count(*) from orchestration_v2_projection_turn_items where thread_id='${first.childThreadId}' and type in ('assistant_message','command_execution','file_change','dynamic_tool','user_input_request') group by type`).split("\n");
    check(items.some((i) => i.startsWith("command_execution:")) && items.some((i) => i.startsWith("assistant_message:")), "the child shows streamed text and tool items", items);

    const second = delegated(send(parentId, { tool: "delegate_task", args: { task: "scenario: success\nWrite hello.", title: "[proof] cloud agent to stop", target: { providerInstanceId: "cloudAgent", model: "sol" } } }));
    const secondAgent = await waitFor(() => fakeRequests().filter((r) => r.path.match(/^\/api\/cloud-agents\/agents\/ag_\d+\/events/)).map((r) => r.path.match(/ag_\d+/)?.[0]).find((id) => id !== agentId), "the second agent's stream");
    await sleep(3_000);
    send(parentId, { tool: "task_cancel", args: { taskId: second.taskId } });
    const stop = await waitFor(() => fakeRequests().find((r) => r.method === "POST" && r.path === `/api/cloud-agents/agents/${secondAgent}/stop`), "POST /stop");
    check(Boolean(stop), `Stop (task_cancel) reached POST /agents/${secondAgent}/stop`, stop);

    log(`\nfake Backstage POSTs:\n${fakeRequests().filter((r) => r.method === "POST").map((r) => `  ${r.path} ${JSON.stringify(r.body).slice(0, 120)}`).join("\n")}`);
    log(`\nparent thread: ${BASE}/${env.environmentId}/${encodeURIComponent(parentId)}  (pair a browser with: ${T3} pair --base-dir ${HOME})`);
  } catch (error) {
    check(false, `the proof ran to the end: ${/** @type {Error} */ (error).message}`);
  } finally {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    if (fs.existsSync(REQUESTS)) fs.copyFileSync(REQUESTS, path.join(EVIDENCE, "fake-requests.jsonl"));
    if (!opts.keep) {
      process.kill(-(/** @type {number} */ (server.pid)), "SIGTERM");
      process.kill(-(/** @type {number} */ (fake.pid)), "SIGTERM");
    } else {
      console.log(`servers kept running: t3 pid ${server.pid}, fake pid ${fake.pid}`);
    }
  }
  log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  fs.writeFileSync(path.join(EVIDENCE, "checks.txt"), `${transcript.join("\n")}\n`);
  console.log(`evidence: ${EVIDENCE}`);
  process.exit(failures);
}

await main();
