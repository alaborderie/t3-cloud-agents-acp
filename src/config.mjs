// @ts-check
// Bridge configuration, the brief T3 sends, and the target repository.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * @typedef {{ id: string, name: string, tier?: string, harness?: string, model?: string, effort?: string }} ModelChoice
 * @typedef {{ backstageUrl: string, token: string, models: ModelChoice[], defaultModel: string, repo: string | null, base: string | null, stateDir: string }} Config
 * @typedef {{ prompt: string, repo?: string, base?: string, branch?: string }} Brief
 */

/** @type {ModelChoice[]} */
export const TIER_MODELS = [
  { id: "flash", name: "Cloud flash (OpenCode DeepSeek)", tier: "flash" },
  { id: "sol", name: "Cloud sol (Codex GPT Sol)", tier: "sol" },
  { id: "opus", name: "Cloud opus (Claude Opus)", tier: "opus" },
];

/** @param {string} file */
const readTrimmed = (file) => fs.readFileSync(file, "utf8").trim();

/**
 * Reads `--config <file>`, else $CLOUD_AGENT_ACP_CONFIG, else ~/.config/cloud-agent-acp/config.json.
 * $BACKSTAGE_URL, $CLOUD_AGENTS_TOKEN and $CLOUD_AGENTS_TOKEN_FILE override the file.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Config}
 */
export function loadConfig(argv, env) {
  const flag = argv.indexOf("--config");
  const file =
    (flag >= 0 ? argv[flag + 1] : undefined) ??
    env.CLOUD_AGENT_ACP_CONFIG ??
    path.join(os.homedir(), ".config", "cloud-agent-acp", "config.json");
  /** @type {Record<string, any>} */
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const tokenFile = env.CLOUD_AGENTS_TOKEN_FILE ?? raw.tokenFile;
  const token = env.CLOUD_AGENTS_TOKEN ?? (tokenFile ? readTrimmed(tokenFile) : raw.token);
  const backstageUrl = env.BACKSTAGE_URL ?? raw.backstageUrl;
  if (!backstageUrl) throw new Error(`No Backstage URL: set backstageUrl in ${file} or $BACKSTAGE_URL`);
  if (!token) throw new Error(`No cat_ token: set tokenFile in ${file} or $CLOUD_AGENTS_TOKEN_FILE`);
  const models = [...TIER_MODELS, ...(raw.models ?? [])];
  const defaultModel = raw.defaultModel ?? "flash";
  if (!models.some((m) => m.id === defaultModel)) throw new Error(`Unknown defaultModel ${defaultModel}`);
  return {
    backstageUrl,
    token,
    models,
    defaultModel,
    repo: raw.repo ?? null,
    base: raw.base ?? null,
    stateDir:
      raw.stateDir ??
      path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "cloud-agent-acp"),
  };
}

const T3_BLOCKS = ["t3_code_instructions", "runtime_info", "pull_request_linking"];

/**
 * The user's words from a T3 prompt: the `<user_request>` body when T3 wraps it, without the
 * harness blocks T3 adds for local agents.
 * @param {ReadonlyArray<{ type: string, text?: string, resource?: { text?: string } }>} blocks
 */
export function userRequest(blocks) {
  const text = blocks
    .map((block) => block.text ?? block.resource?.text ?? "")
    .join("\n");
  const wrapped = text.match(/<user_request>\n?([\s\S]*?)\n?<\/user_request>/);
  if (wrapped) return wrapped[1].trim();
  let rest = text;
  for (const tag of T3_BLOCKS) rest = rest.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  return rest.trim();
}

/**
 * Leading `repo:`, `base:` and `branch:` lines override the defaults and are removed.
 * @param {string} text @returns {Brief}
 */
export function parseBrief(text) {
  /** @type {Brief} */
  const brief = { prompt: text };
  const lines = text.split("\n");
  let index = 0;
  for (; index < lines.length; index++) {
    const header = lines[index].match(/^(repo|base|branch):\s*(\S+)\s*$/i);
    if (!header) break;
    brief[/** @type {"repo" | "base" | "branch"} */ (header[1].toLowerCase())] = header[2];
  }
  brief.prompt = lines.slice(index).join("\n").trim();
  return brief;
}

/** @param {string} url @returns {string | null} owner/name of a GitHub remote */
export function githubRepo(url) {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Repo and base for a new agent: the brief, then the config, then the folder's `origin`.
 * @param {Brief} brief @param {Config} config @param {string} cwd
 */
export function resolveTarget(brief, config, cwd) {
  const explicit = brief.repo ?? config.repo;
  if (explicit) return { repo: explicit, base: brief.base ?? config.base ?? "main" };
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const repo = remote ? githubRepo(remote) : null;
  if (!repo) {
    throw new Error(
      `No repository for ${cwd}: it has no GitHub origin remote. Start the brief with a line "repo: owner/name".`,
    );
  }
  const originHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return { repo, base: brief.base ?? config.base ?? originHead?.replace(/^origin\//, "") ?? "main" };
}
