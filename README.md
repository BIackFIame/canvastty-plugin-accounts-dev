# CanvasTTY Accounts

> **Requires the CanvasTTY core with plugin API v2** (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions, and `launch.delegable`): the upcoming release after 1.7.0. CanvasTTY 1.7.0 and earlier do not have these extension points, so installing it there fails the manifest check.

[Русский](README.ru.md)

Any agent on any model. Run **Claude Code, Codex, OpenCode, Qwen Code or Kimi** on a model of your choice — a local
Ollama model, Ollama Cloud, Z.AI, MiniMax, OpenRouter or any Anthropic- or OpenAI-compatible API — chosen per launch.

## Use

1. Install the plugin, then trust its native code in **Settings → Agents → Extension native code**.
2. Open **Model accounts** (the plugin's settings page) and add an account: provider (the address is filled in),
   name, model, which agents may use it. For an API, save its key (write-only). **Check** lists the models of an
   Ollama server on this computer, or checks a saved key's format — nothing is sent to a paid API.
3. In the agent launcher: **Advanced → Use CanvasTTY Accounts**, choose the **Model account**, optionally a
   **Reasoning effort** and **I trust this folder**.

Orchestrators get two tools: `canvastty-accounts__list_routes` (every account × agent, ready or why not) and
`canvastty-accounts__pick_account` (the first ready account for an agent, skipping ones that cannot work now). Both
answer with `launchOptions` to pass to `spawn_agent`. They probe only the accounts a requested row needs, four at a
time; an Ollama too old for the launch is `ollama-old` with the launch's own reason, an agent without the requested
effort is `no-effort`, and an unknown effort is an error. The plugin declares its launch options delegable
(`launch.delegable` in the manifest; without it CanvasTTY refuses them in `spawn_agent`): an
orchestrator's choice changes only the model, its endpoint and the reasoning effort. *I trust this folder* (a Codex
`-c projects=…` trust or the account home's trust entry) is ignored for a subagent, the configs it writes (OpenCode,
Kimi, Codex `-c`) set no approval, permission or sandbox keys, and CanvasTTY
still applies the subagent's own profile, hooks and isolation layer. An account run uses the account's own Claude/Codex
home, so the person's `~/.claude` or `~/.codex` settings (their own allow or deny rules) are not read there.

OpenRouter carries only the Assistant's Jev decisions, never model traffic. An account on `openrouter.ai` (or a
subdomain) still runs an agent you start yourself, but a subagent is refused on it, and routes mark it
`decisions-only` without `launchOptions`, so `pick_account` skips it. OpenCode on an account sees
only that account's provider (`enabled_providers`), and its titles, summaries, compaction and own subagents use the
account's model (`small_model` and each native agent's `model`), whatever your global OpenCode config names.

Quota. For a Z.AI or BigModel (GLM Coding Plan) account the service reads the plan's quota itself, on its own schedule,
whether or not a page is open: `GET /api/monitor/usage/quota/limit` on the account's own host (`api.z.ai` or
`open.bigmodel.cn`), with the account's key, redirects refused. It reads often while the account is used, every few
minutes while it is used up, just after a predicted reset, and rarely while idle (at most 40 reads an hour; failures
back off). `list_routes` shows each such account's `quota` (state, percent left, window, reset time, source, read time
and age, confidence), and `pick_account` skips an account whose quota is used up. A read older than 30 minutes is
`stale`: unknown, never "used up". A reset time that passed makes it "probably reset" and it is read again; a read that
shows room before the predicted reset clears the exhaustion at once (an early or bonus reset). The state survives
restarts (`quota.json` in the plugin's data folder, without keys). Other providers' quotas are not read.

## What it does to a launch

- Claude Code: `ANTHROPIC_BASE_URL` (Ollama gets its server root), `ANTHROPIC_AUTH_TOKEN` (the key, or `ollama` for a
  local server), every model tier set to the account's model, `--model`, and the base URL repeated in `--settings` so a
  project's settings cannot redirect the key. Claude runs in the account's own `CLAUDE_CONFIG_DIR` under the plugin's
  data folder, with onboarding done. Its `.claude.json` keeps what Claude wrote; a file that is not a settings object
  is kept aside as `.claude.json.unreadable`, one that cannot be read refuses the launch, and the homes are private
  (0700).
- Codex: a provider given only by `-c` overrides (Responses wire API), a one-model catalog in the run's private
  folder, the account's own `CODEX_HOME`, and the key's variable named by `env_key`.
- OpenCode: a private `OPENCODE_CONFIG` file (Anthropic APIs get `/v1`), the key as `{env:…}`.
- Qwen Code: `--auth-type openai` with `OPENAI_*`. Kimi: an `openai_legacy` provider in `--config` (keyless) or a
  private `--config-file`.
- Ollama on this computer: the model is pinned `name:local`, so the server itself refuses to forward it to the cloud;
  the launch checks first that Ollama runs, the model is installed and can call tools.
- Every account launch is marked `thirdPartyModel` (unless it is the agent's own vendor API: Anthropic for Claude Code,
  OpenAI for Codex), so CanvasTTY runs the **Auto** profile as accept-edits in the CLI's sandbox: the CLI's own auto
  reviewer would be the account's model, and a weak model's classifier is not a safety boundary.
- A subagent in (or below) the folder the person chose for its orchestrator: the folder CanvasTTY hands over as
  `trustedFolder` is marked trusted in the account's own Claude config (Codex gets it from CanvasTTY directly).

Keys stay in CanvasTTY's encrypted plugin secrets; CanvasTTY puts them into the agent's environment itself and masks
them in everything other agents read. Nothing is written to `~/.claude`, `~/.codex`, `~/.qwen`, `~/.kimi` or
`~/.ollama`, and the agents' own sign-ins are never used for an account's endpoint.

If the saved accounts cannot be read when the service starts, the page, launcher, launches and tools refuse until a
later read succeeds; nothing is saved over them. Saves and key bindings change what the service shows only after
CanvasTTY stored them. An Ollama answer is read up to 4 MiB. Between the service and CanvasTTY a frame is at most
1 MiB, a host call fails after 30 s or past 64 in flight, and waiting events and logs are capped at 8 MiB.

Needs CanvasTTY with the account launch points (`optionsFrom` launcher lists, `spawn_agent` `launchOptions`, merged
Claude `--settings`); the Auto downgrade and `trustedFolder` need the Auto profile points (older CanvasTTY ignores them).

## Develop

`ESBUILD=/path/to/esbuild node scripts/build.mjs` builds `services/accounts.mjs` and `settings/accounts.js` and stamps
the manifest. `npm test` runs the tests (set `CANVASTTY_REPO` to a CanvasTTY checkout to also run its manifest
validator).
