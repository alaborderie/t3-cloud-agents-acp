---
name: verify-cloud-agent-acp
description: Prove cloud-agent-acp, the ACP bridge that shows Backstage cloud agents as T3 Code sub-threads, on the official T3 0.1.7 release against the repo's fake Backstage server. Use after changing src/, test/fake-backstage.mjs, or scripts/t3-proof.mjs, or when asked to show that delegation, questions, Stop, or restart work in real T3.
---

# Verify cloud-agent-acp

The user surface is T3 Code. A parent thread calls `delegate_task` with `target.providerInstanceId: "cloudAgent"`, and the bridge shows the cloud agent as a child thread. `scripts/t3-proof.mjs` drives that whole path in a throwaway T3 home, so wrap it. Do not rebuild its steps by hand.

Never touch `~/.t3`, the live T3 service, or port 3773. The proof refuses `--home ~/.t3`.

## Launch

```sh
npm ci
npm test
node scripts/t3-proof.mjs --keep
```

`npm test` runs the mapping tests and the stdio tests (about 3 s). The proof does the rest:

- It installs T3 0.1.7 into `~/t3-acp-proof`, unless that version is already there. This needs network access to `t3.codes` and GitHub.
- It writes `~/t3-acp-proof/userdata/settings.json` with two providers: `cloudAgent` (the bridge) and `scriptedParent` (`test/t3/scripted-parent.mjs`). The scripted parent turns each JSON message into one T3 MCP tool call, so no paid model is needed.
- It starts the fake Backstage on port 7480 and `t3 serve` on port 47811.

The instance is ready when the script prints `PASS T3 server runs the official 0.1.7`. Without `--keep`, the script stops both servers itself.

## Doctor

Run this read-only check before driving a kept instance:

```sh
~/t3-acp-proof/bin/t3 --version                                  # t3 v0.1.7
curl -s http://127.0.0.1:47811/.well-known/t3/environment | grep -o '"serverVersion":"[^"]*"'
curl -s -H 'authorization: Bearer cat_fake' http://127.0.0.1:7480/api/cloud-agents/agents | head -c 200
ss -ltnp | grep -E ':(47811|7480)\b'                              # owned by the pids the proof printed
```

If a port is held by a process this run did not start, stop. Do not drive or kill it. Pass `--port` and `--fake-port` to use other ports.

## Drive

Run `node scripts/t3-proof.mjs`. It runs every check in [features/](features/README.md) except restart, and it exits with the number of failed checks.

To drive one step by hand on a kept instance, send JSON tool calls to the parent thread that the script printed:

```sh
T3="$HOME/t3-acp-proof/bin/t3"; H="$HOME/t3-acp-proof"
$T3 thread send --base-dir $H --wait <parentThreadId> '{"tool":"delegate_task","args":{"task":"scenario: success\nWrite hello.","title":"manual","target":{"providerInstanceId":"cloudAgent","model":"flash"}}}'
$T3 thread show --base-dir $H --json --messages 5 <parentThreadId>
```

To see the UI, pair a browser with `$T3 pair --base-dir $H` and open the parent thread URL that the script printed.

## Evidence

Each run writes `~/t3-acp-proof/evidence/<timestamp>/`, and cleanup keeps it:

- `checks.txt` holds every PASS or FAIL line with its evidence.
- `fake-requests.jsonl` holds every request the fake Backstage received. The Authorization header is not included.

A proof must show these side effects in `fake-requests.jsonl`:

- `POST /agents`
- `POST /agents/:id/reply` with `{"questionId":"ask-1","answer":"yes"}`
- `POST /agents/:id/stop`

A message in the thread alone is not enough. The child's lineage and tool items come from the throwaway database, which the script reads with `sqlite3 ... ?mode=ro`.

## Cleanup

Without `--keep`, the script kills the process groups it started. With `--keep`, kill the two pids it printed (`kill -- -<pid>`). Never use `pkill -f` with a pattern: it can match your own shell. Delete `~/t3-acp-proof` only when you want a fresh install. Keep `evidence/` if the proof is still needed.
