// @ts-check
// Pure translation from Backstage agent events to ACP session updates.

/**
 * @typedef {{ seq: number, runId: string | null, event: { type: string, [key: string]: any } }} AgentEnvelope
 * @typedef {"queued" | "running" | "needs_input" | "succeeded" | "failed" | "stopped"} AgentStatus
 * @typedef {{ status: string, branch: string, pr_url: string | null, error: string | null }} RunFinished
 * @typedef {{ lastSeq: number, lastRun: RunFinished | null, costUsd: number }} StreamState
 * @typedef {{ sessionUpdate: string, [key: string]: unknown }} SessionUpdate
 * @typedef {{ type: "needs_input" } | { type: "terminal", status: AgentStatus }} StreamSignal
 * @typedef {{ state: StreamState, updates: SessionUpdate[], signal: StreamSignal | null }} StepResult
 */

/** @type {ReadonlySet<string>} */
export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped"]);

/** @type {Readonly<Record<string, string>>} */
const TOOL_KINDS = {
  shell: "execute",
  read: "read",
  edit: "edit",
  search: "search",
  web: "fetch",
  task: "think",
  mcp: "other",
  other: "other",
};

/** @returns {StreamState} */
export function initialStreamState(lastSeq = -1) {
  return { lastSeq, lastRun: null, costUsd: 0 };
}

/** @param {string} text @returns {SessionUpdate} */
const message = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** @param {string} text @returns {SessionUpdate} */
const thought = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

/** @param {string | null} runId @param {string} callId */
const toolCallId = (runId, callId) => `${runId ?? "run"}:${callId}`;

/** @param {string} text */
const paragraph = (text) => (text.endsWith("\n\n") ? text : `${text.trimEnd()}\n\n`);

/** @param {unknown} value */
const oneLine = (value) => {
  const text = String(value ?? "").split("\n").find((line) => line.trim().length > 0) ?? "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/** @param {string} name @param {any} input */
function toolTitle(name, input) {
  if (input && typeof input === "object") {
    for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
      if (typeof input[key] === "string" && input[key].trim()) return oneLine(input[key]);
    }
  }
  return name;
}

/**
 * Applies one envelope. Envelopes at or below `state.lastSeq` were already shown, so they
 * produce nothing; that makes a reconnect or a resume after restart safe to replay.
 * @param {StreamState} state
 * @param {AgentEnvelope} envelope
 * @returns {StepResult}
 */
export function step(state, envelope) {
  if (envelope.seq <= state.lastSeq) return { state, updates: [], signal: null };
  const next = { ...state, lastSeq: envelope.seq };
  const { runId, event } = envelope;
  /** @type {SessionUpdate[]} */
  const updates = [];
  /** @type {StreamSignal | null} */
  let signal = null;

  switch (event.type) {
    case "run.started":
      updates.push(
        thought(
          `Cloud run started: ${event.harness} ${event.model} (${event.effort}) on ${event.repo}, branch ${event.branch}.\n`,
        ),
      );
      break;
    case "assistant.message":
      updates.push(event.parent_call_id ? thought(paragraph(event.text)) : message(paragraph(event.text)));
      break;
    case "tool.call":
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: toolCallId(runId, event.call_id),
        title: toolTitle(event.name, event.input),
        kind: TOOL_KINDS[event.kind] ?? "other",
        status: "in_progress",
        rawInput: event.input,
      });
      break;
    case "tool.result":
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: toolCallId(runId, event.call_id),
        status: event.is_error ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: event.output } }],
        rawOutput: event.output,
      });
      break;
    case "question":
      if (!event.blocking) {
        updates.push(thought(`Question (the agent continues with its default): ${event.question}\n`));
      }
      break;
    case "usage": {
      next.costUsd = state.costUsd + (event.cost_usd ?? 0);
      updates.push({
        sessionUpdate: "usage_update",
        used: event.input_tokens + event.output_tokens,
        size: 0,
        ...(next.costUsd > 0 ? { cost: { amount: next.costUsd, currency: "USD" } } : {}),
      });
      break;
    }
    case "rate_limit":
      if (event.status !== "allowed") {
        const resets = event.resets_at ? ` Resets at ${event.resets_at}.` : "";
        updates.push(thought(`Rate limit ${event.status}: ${event.message ?? event.window ?? ""}.${resets}\n`));
      }
      break;
    case "log":
      if (event.level !== "info") updates.push(thought(`[${event.source} ${event.level}] ${event.message}\n`));
      break;
    case "run.finished":
      next.lastRun = {
        status: event.status,
        branch: event.branch,
        pr_url: event.pr_url ?? null,
        error: event.error ?? null,
      };
      break;
    case "agent.run_started":
      if (event.reason !== "initial") updates.push(thought(`New cloud run started (${event.reason}).\n`));
      break;
    case "agent.status":
      if (event.status === "needs_input") signal = { type: "needs_input" };
      else if (TERMINAL_STATUSES.has(event.status)) signal = { type: "terminal", status: event.status };
      break;
    default:
      break;
  }
  return { state: next, updates, signal };
}

/**
 * The last message of the turn, which T3 delivers to the parent thread as the result.
 * @param {{ id: string, status: string, branch?: string, prUrl?: string | null }} agent
 * @param {RunFinished | null} lastRun
 */
export function finalSummary(agent, lastRun) {
  const prUrl = agent.prUrl ?? lastRun?.pr_url ?? null;
  const branch = agent.branch ?? lastRun?.branch;
  const lines = [`Cloud agent ${agent.id} ${agent.status}.`];
  if (branch) lines.push(`Branch: ${branch}`);
  lines.push(`PR: ${prUrl ?? "none"}`);
  if (agent.status !== "succeeded" && lastRun?.error) lines.push(`Error: ${lastRun.error}`);
  return message(lines.join("\n"));
}
