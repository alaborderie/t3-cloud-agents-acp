# cloud-agent-acp reference

## Configuration

`src/main.mjs` reads a JSON file from the first of these paths that is set:

1. `--config <file>`
2. `$CLOUD_AGENT_ACP_CONFIG`
3. `~/.config/cloud-agent-acp/config.json`

| Field | Environment override | Default | Meaning |
| --- | --- | --- | --- |
| `backstageUrl` | `BACKSTAGE_URL` | none, required | Backstage origin. The bridge calls `<backstageUrl>/api/cloud-agents`. |
| `tokenFile` | `CLOUD_AGENTS_TOKEN_FILE` | none | File that holds the `cat_` token. |
| `token` | `CLOUD_AGENTS_TOKEN` | none | The token itself, when no token file is set. |
| `defaultModel` | none | `flash` | Model of a new session. |
| `models` | none | `[]` | Extra models: `{id, name, harness, model, effort?}`. |
| `repo` | none | the folder's `origin` | `owner/name` for every new agent. |
| `base` | none | the `origin` default branch, else `main` | Base branch for every new agent. |
| `stateDir` | none | `$XDG_STATE_HOME/cloud-agent-acp`, else `~/.local/state/cloud-agent-acp` | Where each session's agent id and last event seq are kept. |

The bridge fails to start without a URL or a token. The token appears only in the `Authorization: Bearer` header.

## Models

| ACP model id | `POST /agents` fields |
| --- | --- |
| `flash` | `{"tier": "flash"}` |
| `sol` | `{"tier": "sol"}` |
| `opus` | `{"tier": "opus"}` |
| an entry of `models` | `{"harness", "model", "effort"}` from that entry |

## Brief

The bridge sends the body of T3's `<user_request>` block as the agent's `prompt`. Leading lines `repo: owner/name`, `base: <branch>`, and `branch: <branch>` set those `POST /agents` fields. The bridge removes those lines from the prompt. The `title` is the prompt's first line, cut to 80 characters. The `parent` is `{"source": "t3", "label": <ACP session id>}`.

## ACP to Backstage

| ACP from T3 | Backstage call |
| --- | --- |
| `session/new` | none. The bridge stores a new session with no agent. |
| first `session/prompt` | `POST /agents`, then `GET /agents/:id/events` |
| `session/prompt` after the agent finished | `POST /agents/:id/messages` `{text}`, then the event stream |
| `session/prompt` while the agent needs input | `POST /agents/:id/reply` with the text, once for each open question |
| `session/prompt` that starts with `Continue where you left off.` | none. The bridge resumes the event stream. |
| elicitation answer | `POST /agents/:id/reply` `{questionId, answer}`, once for each question |
| `session/cancel` | `POST /agents/:id/stop` |
| `session/load` | none. The bridge reads the stored session. The next prompt resumes with `?after=<last seq>`. |

## Backstage events to T3

| Event | ACP update | T3 shows |
| --- | --- | --- |
| `run.started` | `agent_thought_chunk` with harness, model, repo, and branch | reasoning |
| `assistant.message` | `agent_message_chunk`, or `agent_thought_chunk` when `parent_call_id` is set | streaming assistant message |
| `tool.call` | `tool_call`. The id is `<runId>:<call_id>`. The kind is `shell`→`execute`, `read`, `edit`, `search`, `web`→`fetch`, `task`→`think`, or `other`. | running tool item |
| `tool.result` | `tool_call_update` with `completed`, or `failed` when `is_error` | finished tool item with its output |
| `question` that does not block | `agent_thought_chunk` | reasoning |
| `question` that blocks | none until `agent.status` is `needs_input` | |
| `usage` | `usage_update`. `used` is input plus output tokens. `cost` is the running total in USD. | token usage |
| `rate_limit` other than `allowed` | `agent_thought_chunk` | reasoning |
| `log` at `warn` or `error` | `agent_thought_chunk` | reasoning |
| `run.finished` | none. The bridge keeps its branch, PR URL, and error for the final message. | |
| `agent.run_started` for a reply or a message | `agent_thought_chunk` | reasoning |
| `agent.status` `needs_input` | `elicitation/create` with one string field per open question, named by its `questionId`. Options become an `enum`. | a question that wakes the parent |
| `agent.status` `succeeded` | final `agent_message_chunk`, then `stopReason: end_turn` | result delivered to the parent |
| `agent.status` `failed` | final `agent_message_chunk`, then a JSON-RPC error | failed result delivered to the parent |
| `agent.status` `stopped` | final `agent_message_chunk`, then `stopReason: cancelled` | cancelled |

The final message reads `Cloud agent <id> <status>.`, then `Branch: <branch>` and `PR: <url or none>`. When the agent did not succeed, it also gives `Error: <error>`. The bridge ignores `skills.ready`, `workspace.ready`, `session.started`, and event types it does not know.

## Pull request link

T3 lists a PR on a thread only once it is linked. A PR URL in the child's messages is not enough. When a run ends with a PR URL, the bridge calls T3's MCP tool `link_pull_request` with `{"url": <url>}`, before it sends the final message. The tool links to the calling thread, which is the child.

- **Endpoint.** T3 passes its MCP server in `mcpServers` at `session/new` and `session/load`. The bridge reads `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` from that entry's `env`. It keeps them in memory only.
- **Once per PR.** The bridge stores the last linked URL with the session. A follow-up run that ends on the same PR does not link it again.
- **Failure.** A failed link does not change the run's result. The child shows `Could not link <url> to this thread in T3.`, and the bridge writes the error to stderr. The next run that ends with that PR tries again.
