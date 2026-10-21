# Changelog

## Unreleased

Requires the CanvasTTY core with plugin API v2 and `launch.delegable`: the upcoming release after 1.7.0.

### What you'll notice

- **Shares accounts and quotas with the Assistant, only if you allow it** (CanvasTTY with shared reads): the service declares two shared reads, `accounts.routes` (model accounts and pools with each account's quota and state) and `accounts.quota` (quota per account, tokens each pool account used in the last 5 h, agents whose own sign-in is used up), data class D1, never keys, homes or paths. Nothing is shared until you approve the pair in Settings → Agents → Extension native code. The account launch field is visible to the Assistant (`visibleTo`) so its launch check sees which account or pool a launch chose. When CanvasTTY reports an agent's own sign-in used up (`limit.exhausted`), `list_routes` and the shared reads say so until its reset; an event naming one of your accounts rests that account. New permission: `usage:read` (tokens per pool account home).
- **Subscription account pools**: several of your own sign-ins per agent (Claude Code, Codex, Grok, Kimi), each signed in once by the agent's own sign-in in a card, each with its own quota (read by CanvasTTY per account home where it can) and the data level you set. A launch on `pool:<agent>` takes the signed-in account with the most quota left, skips used-up, signed-out and busy ones (one card per sign-in), and restored cards keep their account. `list_routes` and `pick_account` include them. New permissions: `limits:read`, `sessions:events`, `sessions:launch`.
- Z.AI / BigModel (GLM Coding Plan) accounts show their quota: the service reads it from the account's own host on its own schedule (no page needs to be open), `list_routes` returns it per route with its age and source, and `pick_account` skips an account whose quota is used up until it resets. A reset that comes early (or a bonus reset) is noticed on the next read, which is due within minutes while an account is used up; an old read is shown as old and counts as unknown, never as used up. The settings page shows each account's quota with a *Read now* button.

- OpenRouter is for the Assistant's Jev decisions only: a subagent on an OpenRouter account (`openrouter.ai` or a subdomain, preset or custom) is refused, and `list_routes` marks such accounts `decisions-only` with no `launchOptions`, so `pick_account` never chooses them. An agent you start yourself on one still runs.
- OpenCode on an account no longer sends titles or summaries to a provider your global OpenCode config names (such as OpenCode Zen): its config sets `enabled_providers` to the account's provider, and `small_model` and the model of each native agent (title, summary, compaction, general, explore, build, plan) to the account's model, so a global `agent.<name>.model` can neither redirect those calls nor make them fail.
- No more losing accounts when storage cannot be read at startup: the page and launches refuse with "try again" instead of showing an empty list that the next save would write over your accounts and key bindings.
- A failed save no longer leaves the page showing an account that is not saved, and a removal that did not save keeps the account's agent homes.
- `list_routes` and `pick_account` answer sooner with many accounts: they probe only the accounts a requested row needs, four at a time instead of one after another.
- A route says `ollama-old` or `no-effort` when the launch would fail for that reason, instead of `ready` or a silent default effort.
- The settings page looks up every account's saved key at once instead of one round trip per account, saves one change at a time, and keeps a pasted key in its field when storing it fails.
- Orchestrators can pass these launch options to `spawn_agent` again on the new core, which refuses undeclared ones.

### Accounts and storage

- A failed storage read at start is no longer taken as "nothing saved"; the service reads again on each request and refuses until it can, persisting nothing meanwhile.
- Save and key binding write first and change memory only once the host stored them, one at a time.
- The settings page removes an account before its key (a failed save keeps both).
- The account's Claude Code settings are kept: a broken file is set aside as `.claude.json.unreadable`, an unreadable one refuses the launch, the temporary file is unique, and the homes folder is checked and kept private.

### Routes and launches

- Routes and the launch preflight share one Ollama version rule.
- `list_routes` checks the effort like `pick_account`: an unknown effort is an error, an agent without the level gets `no-effort`.
- A check that finishes after its account was edited or removed does not publish its old result.
- An Ollama answer without Content-Length is cut off at 4 MiB while it is read, instead of being read whole and measured afterwards.
- Launch options declared `launch.delegable`. An orchestrator's choice changes only the model, its endpoint and the effort: folder trust is ignored for subagents, and the OpenCode, Kimi and Codex configurations carry no approval, permission or sandbox keys (tested against the core's pattern; an OpenCode model name that would be such a key is refused).

### Service transport

- Host calls fail after 30 s and past 64 in flight; all pending calls fail when the host closes the connection.
- Incoming frames are cut from raw bytes at the host's 1 MiB limit; an oversized frame is skipped to its newline. Requests beyond 64 running handlers are answered busy.
- A frame over 1 MiB is never written (an answer becomes an error, a host call fails, an event is dropped with a warning). While the host is not reading, frames wait for `drain` and waiting events and logs are capped at 8 MiB, oldest first; answers and host calls are never dropped.
- On shutdown or end of input the service takes no new work and lets running handlers answer during a short drain.
