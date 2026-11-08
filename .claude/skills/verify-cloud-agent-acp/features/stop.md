# Stop a cloud agent

Stop in T3 ends the child's turn as cancelled and stops the cloud agent in Backstage.

## Sub-features

- `stop-running` stops an agent during a run.
- `stop-question` stops an agent while its question is open.

## How to get to it (user POV)

- The parent agent calls `task_cancel` with the task id.
- A user chooses Stop in the parent's relationships panel.

## Driving it with t3-proof

- **Stop a run.** Run `node scripts/t3-proof.mjs`. The check `Stop (task_cancel) reached POST /agents/<id>/stop` passes.
- **Agent state.** On a kept instance, run `curl -s -H 'authorization: Bearer cat_fake' http://127.0.0.1:7480/api/cloud-agents/agents/<id>`. It shows `"status":"stopped"`.
- **Stop at a question.** On a kept instance, delegate or start a run with a brief that asks (no `scenario: success`), then cancel while the question is open. `fake-requests.jsonl` gets `POST /agents/<id>/stop`. [top-level.md](top-level.md) step 6 shows the exact commands. `npm test` also covers this case in `Stop while the question is open also stops the agent`.
- **Stop a top-level thread.** [top-level.md](top-level.md) step 5 sends `t3_thread_interrupt`. The thread ends `interrupted` and the stop request follows.

## Gotchas

- T3 sends `session/cancel` for both Stop and an interrupt, so either one stops the cloud agent.
- Shutting down T3 does not stop cloud agents. See [restart.md](restart.md).
