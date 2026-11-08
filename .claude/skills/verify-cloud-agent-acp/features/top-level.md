# Use a cloud agent in a top-level thread

A user picks **Cloud agent** in a normal new thread and types a request. No parent thread or `delegate_task` call is involved. The bridge creates the cloud agent from that first message, asks the agent's questions in the thread, starts another run for each follow-up, and links the PR to the thread.

## Sub-features

- `top-create` sends `POST /agents` with the message as `prompt` and its first line as `title`, with the repo from the project's `origin` and the `sol` tier. The thread has no parent (`parentThreadId` is null).
- `top-question` shows the agent's question as a T3 question in the thread. The answer reaches `POST /agents/:id/reply`.
- `top-followup` sends a later message to `POST /agents/:id/messages` and ends with the final message again.
- `top-pr-link` lists the run's PR in the thread's `pullRequests`.
- `top-stop` ends the thread as `interrupted` and sends `POST /agents/:id/stop`, also while the question is open.

## How to get to it (user POV)

- Create a normal thread in a project whose folder has a GitHub `origin`, select **Cloud agent** and the `sol` model, then send a request.
- Answer a question in the thread's question form. Send follow-ups in the same thread.

## Driving it by hand

`t3-proof.mjs` does not drive this. Use a kept instance and the doctor in `../SKILL.md`. `T3` and `H` are as in `../SKILL.md`, and the cwd is `$H/project`.

1. **Create and ask.** `$T3 thread start --base-dir $H . --provider cloudAgent --model sol --title "top-level proof" --wait --json "Ask which proof label to use"`. It exits 2 with `"status":"waiting"` because the question is open. A brief without `scenario: success` asks `ask-1` first. `fake-requests.jsonl` gets `POST /agents` with `"title":"Ask which proof label to use"` and `"tier":"sol"`.
2. **Answer.** The CLI cannot answer a question. Use a scripted driver thread: `$T3 thread start --base-dir $H . --provider scriptedParent --model script --wait --json '{"tool":"t3_pending_request","args":{"action":"list","threadId":"<top>"}}'`. Take the id from `requestIds`. Then send `{"tool":"t3_pending_request","args":{"action":"respond","threadId":"<top>","requestId":"<id>","answers":{"ask-1":"Top-level ACP proof"}}}` to that driver thread. `fake-requests.jsonl` gets `POST /agents/<id>/reply` with `{"questionId":"ask-1","answer":"Top-level ACP proof"}`. Build the JSON with `python3 -c` and `json.dumps` so a newline or quote in the id cannot break it.
3. **Result and PR.** After about 30 s, `$T3 thread show --base-dir $H --json --messages 8 <top>` shows `"status":"completed"`, `"parentThreadId":null`, and a `pullRequests` entry for `https://github.com/alaborderie/cloud-agent-runner-sandbox/pull/<n>` (the fake numbers its PRs). The last message gives `Cloud agent <id> succeeded.`, the branch, and `PR: <url>`.
4. **Follow-up.** `$T3 thread send --base-dir $H --wait --json <top> "Add the follow-up proof"`. `fake-requests.jsonl` gets `POST /agents/<id>/messages` with `{"text":"Add the follow-up proof"}`, and the reply is the final message again.
5. **Stop a run.** `$T3 thread start --base-dir $H . --provider cloudAgent --model sol --title "top-level stop" --json $'scenario: success\nWrite hello.'`, wait 4 s, then send `{"tool":"t3_thread_interrupt","args":{"threadId":"<top>"}}` to the driver thread. The thread ends `interrupted` and `fake-requests.jsonl` gets `POST /agents/<id>/stop`.
6. **Stop at a question.** Start with `"Ask something"` and `--wait`, then send the same interrupt while the question is open. `pendingRequestCount` is 0, the status is `interrupted`, and `POST /agents/<id>/stop` follows.

`npm test` covers the dismissed-question and reload path in `a top-level prompt answers a dismissed question and continues after ACP reload on the same agent`, and the stream reconnect path in `reconnect.test.mjs`.

## Gotchas

- A message sent while a question is open does not answer it. T3 queues it as the next run. After the question is answered, the queued text goes to `POST /agents/<id>/messages` as a follow-up. In step 2, `reply` carries the answer and `messages` carries the queued text, so expect both.
- In the fake, a PR from a brief without `scenario: runner-pr` shows with `"source":"created"` in `pullRequests`, because T3 links it from the `gh pr create` item, as in [delegate.md](delegate.md).
- A folder with no GitHub `origin` fails the prompt unless the message starts with `repo: owner/name`.
