# t3-cloud-agents-acp

`cloud-agent-acp` runs a Backstage cloud agent as a normal T3 Code thread or a delegated sub-thread. It is an ACP agent that T3 starts as a **Local ACP command** provider. When a thread calls `delegate_task` with that provider, the bridge creates a cloud agent through the Backstage cloud-agents API. It then streams the agent's text and tool calls into the child thread. A question from the cloud agent becomes a T3 question that wakes the parent thread. Stop in T3 stops the cloud agent. The child's last message gives the branch and the PR URL, and the bridge links that PR to the child thread, so T3 lists it with the thread's pull requests.

It needs Node 22.23.5 or later and has no runtime dependencies. It changes no T3 code. [docs/t3-0.1.7-findings.md](docs/t3-0.1.7-findings.md) records what it relies on in the official T3 0.1.7 release, with file references. [docs/reference.md](docs/reference.md) lists the configuration and the event mapping.

## Install on Jarvis

1. Clone the repository:

	```sh
	git clone https://github.com/alaborderie/t3-cloud-agents-acp ~/repositories/t3-cloud-agents-acp
	```

2. In your Backstage profile, create a personal access token. It starts with `cat_`. Write it to a file that only you can read:

	```sh
	mkdir -p ~/.config/cloud-agent-acp
	install -m 600 /dev/null ~/.config/cloud-agent-acp/token
	$EDITOR ~/.config/cloud-agent-acp/token
	```

3. Write `~/.config/cloud-agent-acp/config.json`:

	```json
	{
		"backstageUrl": "https://backstage.antoinelaborderie.com",
		"tokenFile": "/home/jarvis/.config/cloud-agent-acp/token",
		"defaultModel": "flash"
	}
	```

	The bridge reads the token from the file and sends it only in the `Authorization` header. It never prints the token.

4. Add the provider in T3. In **Settings → Providers → Add provider**, select **Show more**, then **Local ACP command**. Use these values:

	- Executable: `/usr/bin/node`
	- Argument: `/home/jarvis/repositories/t3-cloud-agents-acp/src/main.mjs`
	- Display name: `Cloud agent`
	- Instance ID: `cloudAgent`

	The same entry in `~/.t3/userdata/settings.json` is:

	```json
	"providerInstances": {
		"cloudAgent": {
			"displayName": "Cloud agent",
			"driver": "acpRegistry",
			"config": {
				"source": "local",
				"commandPath": "/usr/bin/node",
				"commandArgs": ["/home/jarvis/repositories/t3-cloud-agents-acp/src/main.mjs"]
			}
		}
	}
	```

	The provider offers three models: `flash`, `sol`, and `opus`. They map to the Backstage tiers of the same names.

## Use Cloud agent in a top-level thread

1. Open a T3 project whose folder has a GitHub `origin` remote.
2. Create a normal new thread and select **Cloud agent** with the `sol` model.
3. Type your request and send it. No `delegate_task` call or `<user_request>` wrapper is needed.
4. Answer blocking questions in the thread's T3 question form. Each answer starts a new Kubernetes Job on the same cloud branch.
5. After the agent finishes, send a follow-up in the same thread. It starts another run on that branch and can update the same PR.

The project folder can be the main checkout or a T3 worktree. The bridge resolves the repository from that folder's `origin`, not its directory name. Leading `repo:`, `base:`, and `branch:` lines override the target for the first message.

T3 keeps the thread and its ACP session id. The bridge persists the Backstage agent id and event cursor on Jarvis, so reloading the ACP session follows the same agent without replaying tool items. The cloud Job exits between runs. Neither T3 Code nor T3 Connect runs in the cluster.

While a T3 turn is active, use T3's queued-message control for a follow-up. Backstage rejects `/messages` during an active cloud run. If an ACP prompt reaches the bridge while that agent is still running, the bridge reports that the message was not sent and keeps following the run. Resend it after the run ends.

The final message gives the agent id, branch, and PR URL. The bridge also links the PR to the thread. **Stop** stops the cloud agent.

## Launch a cloud agent from t3-hub

The hub agent calls `delegate_task` itself, so the child nests under the hub thread:

```json
{
	"task": "<the brief>",
	"title": "[<hub>/<task>#<n>]",
	"target": { "providerInstanceId": "cloudAgent", "model": "sol" }
}
```

- **Repository.** The bridge takes the GitHub `origin` remote of the thread's folder and its default branch. To use another repository, start the brief with header lines such as `repo: owner/name`, `base: main`, or `branch: feat/x`. The bridge removes those lines from the brief.
- **Questions.** A question arrives in the hub thread as a wake message. Read it with `t3_pending_request` action `read`, and answer with action `respond`. The bridge posts each answer to `POST /agents/:id/reply`, and the cloud agent continues on the same branch.
- **Stop.** Call `task_cancel` with the task id, or use Stop in the parent's relationships panel. The bridge calls `POST /agents/:id/stop`.
- **Result.** When the cloud agent finishes, the hub thread gets the child's last message. It reads `Cloud agent <id> succeeded.`, then `Branch: <branch>` and `PR: <url>`. The PR is linked to the child thread, so `list_thread_pull_requests` with the child's `threadId` returns it.
- **Retry.** Send a message to the child thread after it finishes. The bridge posts it to `POST /agents/:id/messages`, which starts a new run on the same branch.
- **Restart.** If T3 restarts during a run, it reloads the session. The bridge then resumes the event stream after the last event it showed.

## Prove it on a throwaway T3

`scripts/t3-proof.mjs` checks the bridge on the official T3 release, against the fake Backstage server in this repository. It never touches `~/.t3`. It needs Node 22.13 or later for `node:sqlite`. It does five things:

1. It installs T3 0.1.7 into `~/t3-acp-proof` with `https://t3.codes/install.sh`, setting `T3CODE_VERSION`, `T3CODE_HOME`, and `T3CODE_INSTALL_BIN_DIR`.
2. It registers the bridge as `cloudAgent`, and a scripted parent agent as `scriptedParent`. The scripted parent needs no paid model. It turns each JSON message into one T3 MCP tool call.
3. It starts the fake Backstage server on port 7480 and `t3 serve` on port 47811.
4. It delegates to the bridge from a parent thread, then answers the cloud agent's question. When the run ends, it calls `list_thread_pull_requests` for the child thread and checks that T3 lists the PR.
5. It delegates a second cloud agent and stops it.

Run it from the repository root:

```sh
node scripts/t3-proof.mjs
```

Each check prints `PASS` or `FAIL`, followed by its evidence. The last line is `ALL CHECKS PASSED` when every check passes. Pass `--keep` to leave both servers running. Then pair a browser with `~/t3-acp-proof/bin/t3 pair --base-dir ~/t3-acp-proof`, and open the parent thread link the script prints.

The fake server prints each request it receives as one JSON line. The proof stores them in `~/t3-acp-proof/bridge/fake-requests.jsonl`. You can also run the fake server alone:

```sh
node test/fake-backstage.mjs --port 7480 --pace 400
```

It accepts the token `cat_fake`. It replays the runner's recorded streams from `test/fixtures/streams`. These are copies of `runner/test/streams` in `alaborderie/backstage-plugin-cloud-agents`. An agent's first run asks one blocking question. The run after the answer ends with a PR URL. A brief that contains `scenario: success` skips the question. A brief that contains `scenario: runner-pr` drops the agent's `gh pr create` call from the streams, as when the runner opens the PR. T3 links a PR on its own when it sees that call, so the proof uses this scenario to check the bridge's link.

## Develop

```sh
npm ci
npm test
npm run typecheck
```

The tests feed every recorded stream through the event mapping. They also run the bridge over stdio against the fake server, covering the question and answer, Stop, a restart, a follow-up message, and the PR link through a fake T3 MCP endpoint.
