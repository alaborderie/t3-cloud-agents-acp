# Answer a cloud agent's question

When the cloud agent ends a run with a blocking question, the child shows a T3 question and the parent thread wakes. The answer goes to Backstage, and the agent continues on the same branch.

## Sub-features

- `question-wake` sends the parent a message: "Delegated task … is blocked on a question".
- `question-read` lets the parent read the question and its options through `t3_pending_request`.
- `question-reply` posts the answer to `POST /agents/:id/reply`.
- `question-resume` lets the child continue to its final message after the answer.

## How to get to it (user POV)

- The parent agent reads the wake message and calls `t3_pending_request` with `action: "read"`, then `action: "respond"`.
- A user answers the question in the child thread in the web UI.

## Driving it with t3-proof

- **Wake.** Run `node scripts/t3-proof.mjs`. The check `the cloud agent's question woke the parent thread` passes.
- **Read.** The check `the parent reads the question with its options` shows `Should I delete README.md?` with options `yes` and `no`.
- **Reply.** The check `the answer reached POST /agents/<id>/reply` shows `{"questionId":"ask-1","answer":"yes"}`.
- **Resume.** The result check for this child passes. See [delegate.md](delegate.md).

## Gotchas

- The fake asks only after the first run ends with `needs_input`. The bridge asks when `agent.status` is `needs_input`, not on each `question` event.
- A question that does not block shows as reasoning, not as a T3 question.
- If the user dismisses the question, the turn ends with "still needs input". A later message to the child is posted as the answer.
