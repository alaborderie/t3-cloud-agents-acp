# Resume after a T3 restart

If T3 restarts while a cloud agent runs, T3 reloads the child's session and sends "Continue where you left off". The bridge resumes the event stream after the last event it showed. The child ends with its result, and no item appears twice.

## Sub-features

- `restart-load` makes T3 call `session/load` with the same session id.
- `restart-resume` makes the bridge call `GET /agents/:id/events?after=<seq>`, and it posts nothing to the agent.
- `restart-result` still delivers the final message to the parent.

## How to get to it (user POV)

- The T3 service restarts, for example after an update, while a delegated cloud agent runs.

## Driving it with t3-proof

The proof script does not restart T3. Drive this one by hand on a kept instance.

1. Run `node scripts/t3-proof.mjs --keep`, and note the parent thread id and the t3 pid it prints.
2. Delegate a run that lasts about 12 s: `t3 thread send --base-dir ~/t3-acp-proof --wait <parent> '{"tool":"delegate_task","args":{"task":"scenario: success\nRestart test.","title":"restart","target":{"providerInstanceId":"cloudAgent","model":"flash"}}}'`.
3. After 5 s, run `kill -- -<t3 pid>`. Then start the server again: `~/t3-acp-proof/bin/t3 serve --base-dir ~/t3-acp-proof --port 47811 --host 127.0.0.1 --no-browser ~/t3-acp-proof/project`.
4. Within 30 s, `fake-requests.jsonl` shows `GET /api/cloud-agents/agents/<id>/events?after=<n>`. The parent shows `[completed]` with `PR: https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/3`.
5. Count the child's tool items with `sqlite3 "file:$HOME/t3-acp-proof/userdata/statev2.sqlite?mode=ro" "select type, count(*) from orchestration_v2_projection_turn_items where thread_id='<child>' group by type"`. The result is 4 `command_execution`, 2 `dynamic_tool`, and 1 `file_change`, which is 7 tool items in total.

`npm test` covers the same path in `after a restart, session/load resumes the stream without repeating items`.

## Gotchas

- The bridge stores each session's last seq under `~/t3-acp-proof/bridge/state/sessions/`. Deleting that folder makes `session/load` fail.
- The restart prompt never reaches Backstage as a message.
- The server you start in step 3 has a new pid. Kill that pid at cleanup, not the one the proof printed.
