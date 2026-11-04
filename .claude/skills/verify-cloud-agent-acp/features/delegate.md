# Delegate to a cloud agent

A parent thread delegates a brief to the `cloudAgent` provider. A child thread appears under the parent, streams the agent's text and tool items, and sends its final message with the PR URL back to the parent.

## Sub-features

- `delegate-create` sends `POST /agents` with the repo from the project's `origin` remote and the model's tier.
- `delegate-nest` makes the child a `subagent` of the parent, hidden from the top-level thread list.
- `delegate-stream` shows text and tool items in the child.
- `delegate-result` delivers `Cloud agent <id> succeeded.`, the branch, and `PR: <url>` to the parent.
- `delegate-followup` sends a later message to `POST /agents/:id/messages`.
- `delegate-pr-link` links the run's PR to the child thread, so T3 lists it with the thread's pull requests.

## How to get to it (user POV)

- An agent in the parent thread calls `delegate_task` with `target: {providerInstanceId: "cloudAgent", model: "flash" | "sol" | "opus"}`.
- A user opens the child from the parent's relationships panel in the web UI.

## Driving it with t3-proof

- **Delegate.** Run `node scripts/t3-proof.mjs`. The `delegate_task to the cloudAgent provider created a child thread` check passes.
- **Nesting.** The checks `the child is a subagent of the parent thread` and `the top-level thread list shows the parent and not the nested child` pass.
- **Create request.** The check `POST /agents uses the project's origin repo and the selected tier` shows `repo: alaborderie/cloud-agent-runner-sandbox` and `tier: flash`.
- **Stream.** The check `the child shows streamed text and tool items` lists `command_execution`, `file_change`, and `assistant_message` items.
- **Result.** The check `the parent received the final message with the PR URL` shows `PR: https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/3`.
- **PR link.** The check `T3 lists the cloud agent's PR on the child thread (list_thread_pull_requests)` shows an entry with that URL and `"source":"agent"`. The proof's brief has `scenario: runner-pr`, so T3 cannot link the PR from a `gh pr create` item itself.
- **Follow-up.** On a kept instance, send any text to a finished child with `t3 thread send --base-dir ~/t3-acp-proof --wait <childThreadId> "Also add a newline"`. `fake-requests.jsonl` gets `POST /agents/<id>/messages`.

## Gotchas

- `t3 thread list` shows only top-level threads. Read the lineage from `orchestration_v2_projection_threads.payload_json`.
- T3 stores each tool item's title as `Tool`. The web UI summarizes them, for example "Ran 4 commands, changed 1 file".
- The test project's `origin` is set to the sandbox repo. A folder with no GitHub `origin` fails the prompt unless the brief starts with `repo: owner/name`.
