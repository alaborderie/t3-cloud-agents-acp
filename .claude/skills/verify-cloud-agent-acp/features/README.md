# cloud-agent-acp verification map

This directory lists the user-facing behaviors of the bridge in T3 Code. Read this index first, then use the feature file as the recipe.

## Baseline preconditions

- `node scripts/t3-proof.mjs --keep` printed `PASS T3 server runs the official 0.1.7`.
- The doctor in `../SKILL.md` passes, and ports 47811 and 7480 belong to that run.
- The fake Backstage accepts only the token `cat_fake`.

## Driving conventions

- Act as the parent thread through `test/t3/scripted-parent.mjs`. Send it one JSON tool call per message with `t3 thread send --wait`. A top-level thread has no parent, so answer its question and interrupt it from a `scriptedParent` driver thread, as [top-level.md](top-level.md) shows.
- Read a child's state from `t3 thread show --json`, from `~/t3-acp-proof/bridge/fake-requests.jsonl`, and from the throwaway database in read-only mode.
- A brief that contains `scenario: success` skips the question. Any other brief asks `ask-1` first.
- A brief that contains `scenario: runner-pr` drops `gh pr create` from the streams, so only the bridge can link the PR.

## Proof and skip reporting

- Every proof names the fake request it caused, not only the message T3 shows.
- If a step could not run, report the command and the unmet precondition. Do not report it as verified through another feature.

## Features

- [delegate.md](delegate.md): a delegated cloud agent appears as a child thread with streaming text and tool items.
- [question.md](question.md): the cloud agent's question wakes the parent, and the answer reaches Backstage.
- [stop.md](stop.md): Stop ends the child and stops the cloud agent.
- [restart.md](restart.md): a T3 restart resumes the child without repeating items.
- [top-level.md](top-level.md): a normal thread on the Cloud agent provider creates, asks, follows up, links the PR, and stops with no parent thread.
