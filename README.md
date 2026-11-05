# Auto Mode

Auto Mode checks coding-agent actions for prompt injection and authorization against the user's instructions. A shared in-process runtime sends decisions to a remote model: Typesafe's native JEV API by default, or a configured OpenAI-compatible chat-completions endpoint. Harness adapters share the same `core/` and `adapters/shared/` code; omp is the current adapter.

Every tool call is checked before execution. Tool-result text is checked before the agent receives it. A positive decision permits the step to continue through the harness's own controls; a blocked or unavailable decision stops it. There is no interactive override of a blocked decision.

> [!WARNING]
> This is an additional safety gate, not a sandbox or a guarantee. Decision models can miss attacks, misunderstand scope and reject legitimate work. Approved actions still run with the agent process's filesystem, shell and network access. Keep the harness's restrictions, isolate sensitive work and retain recoverable history.
>
> Evaluation sends user prompts, the active goal, agent identity, raw tool arguments, working directory and recent tool-result text to the chosen endpoint. These may contain proprietary code, personal information or credentials. Review the provider's privacy, retention and billing terms before enabling it. Do not use it for data you cannot send to that provider.

## Install

Use Node.js 22 or newer. Download and unpack a release, or clone the repository. The project has no runtime package dependencies and needs no build step.

Configure an API key before starting omp. For the native Typesafe service, set `TYPESAFE_API_KEY` in the environment inherited by omp. Alternatively, set `AUTO_MODE_API_KEY`. Keys are absent by default: without one, enabled Auto Mode blocks actions rather than silently bypassing evaluation.

Install the extension for your user, or add `-l` for one project:

```bash
omp install /full/path/to/auto-mode/adapters/omp
```

To load it for one run:

```bash
omp --extension /full/path/to/auto-mode/adapters/omp
```

The extension loads the shared decision runtime inside the omp process; there is no separate service, port or startup step. `/auto-mode` opens its settings. Restart omp after changing its startup environment so the extension reads the new environment.

## How decisions work

The evaluator receives the full direct-user prompt history from the root session's current active branch. Earlier restrictions remain in force unless a later direct user instruction in that branch explicitly changes them. Human-submitted goal objectives are accepted through their user-attributed prompts; an assistant's plan, task description, saved goal or tool output cannot grant new authority. The active goal is subordinate context, not a replacement for the user conversation.

For example, after “fix the bug, but do not commit,” a later “run the tests” does not authorize a commit. Necessary investigation, editing and testing can be within a fix request; publishing, pushing, spending, changing permissions or unrelated destructive actions require authorization appropriate to those side effects.

Action checks ask whether the complete proposed tool input is free of injection and authorized. This includes shell commands, nested evaluation payloads, delegated tasks and MCP calls, not just recognized tool names. Reading a suspicious file is not itself an injection; the returned text is checked separately before delivery. Output checks ask whether text is attempting to redirect the agent away from its authorized work. Quoted attacks, security research and ordinary instructions in documentation are not automatically malicious; attempts to steal data, spoof authority or conceal behavior are evaluated in context.

A decision has one of these categories:

| Category | Effect | Meaning |
| --- | --- | --- |
| `safe` | `allow` | Required choices are clean and authorized, with sufficient reported confidence. |
| `injection` | `block` | The evaluator identifies a prompt-injection attempt. |
| `scope` | `block` | The proposed action is outside the user's authorization. |
| `uncertain` | `block` | Context or confidence is insufficient, or the evaluator cannot decide safely. |
| `unavailable` | `block` | Configuration, transport or response processing cannot provide a usable decision. |

Missing user context, oversized input, low confidence, malformed responses, provider failures and timeouts fail closed. Input is not silently shortened to fit a decision request. No fallback provider or remote-request retry is used. Recent accepted output supplies context, not permission; clearing decision statistics does not erase user restrictions. An earlier blocked output does not permanently block unrelated clean work.

Blocked tool-result text is withheld and the agent is interrupted. A block does not undo the tool call that produced that result, so the pre-execution action gate matters. A separate block on a later action is not a substitute for withholding hostile text now. Disabling Auto Mode explicitly bypasses its checks and leaves the harness's controls responsible for safety; an unreachable provider is not the same as disabled.

See [Policy](docs/policy.md) for the trust boundary and [Architecture](docs/architecture.md) for the request lifecycle and module boundaries.

## Providers

### Native Typesafe JEV

The default configuration is:

```json
{
  "provider": "typesafe",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest"
}
```

The evaluator uses `Authorization: Bearer <apiKey>` and Typesafe's native System One protocol, not chat completions. It sends structured `state` plus categorical choice `questions`: injection (`clean`, `injection`, `uncertain`) and, for actions, scope (`authorized`, `out_of_scope`, `uncertain`). Returned choices, confidence and probabilities are validated. JEV does not generate an explanatory paragraph here; reasons shown by Auto Mode are fixed category descriptions, not invented quotations or evidence from the provider.

Protocol reference: [Typesafe System One API](https://docs.typesafe.ai/api/system-one.md).

A gateway accepting the same JEV `state`/question-map protocol can use `provider: "typesafe"` with its own complete endpoint URL and model identifier. Configure a key explicitly for that destination; the protocol name does not restrict the endpoint to Typesafe's host.

### Custom decision endpoint

Select `custom` for a decision service that speaks OpenAI-compatible chat completions. Unlike the JEV default, there is no bundled URL or model: both fields start empty, and actions block until you supply them. JEV itself is not served by this option; use `typesafe` for native JEV.

```json
{
  "provider": "custom",
  "endpoint": "https://your-provider.example/v1/chat/completions",
  "model": "your-decision-model"
}
```

For a custom endpoint, either save an explicit `apiKey` through `/auto-mode`, or set `AUTO_MODE_PROVIDER=custom`, `AUTO_MODE_ENDPOINT` and `AUTO_MODE_API_KEY` together in omp's environment. A file-only custom endpoint does not inherit an unrelated environment key. Do not put a real key in shared configuration examples. A compatible endpoint must accept bearer authentication, system/user messages, `temperature: 0` and `response_format: {"type":"json_object"}`. The user message is the JSON evaluation input, separated from the evaluator's system policy. The response must contain strict JSON in `choices[0].message.content`:

```json
{
  "injection": "clean",
  "scope": "authorized",
  "confidence": 0.95
}
```

`scope` is required for actions and not needed for output checks. The accepted injection labels are `clean`, `injection`, `uncertain`; scope labels are `authorized`, `out_of_scope`, `uncertain`. Confidence is a number from 0 to 1. Prose and Markdown-fenced JSON are not accepted. API compatibility alone does not establish that a chosen model can make reliable security decisions. There is no automatic protocol detection or switch to another provider after failure.

## Settings

The `/auto-mode` menu edits runtime settings and saves them for later starts. Secrets are write-only: the menu and public settings view show whether a key is configured, never the key itself. Text entered into a settings input may still be visible while typing; environment configuration is preferable for secrets.

| Config key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable action and output gates. `false` explicitly bypasses them. |
| `notifications` | `true` | Show optional decision notices; does not change enforcement. |
| `provider` | `"typesafe"` | `typesafe` native JEV or `custom` OpenAI-compatible chat completions. |
| `endpoint` | `"https://api.typesafe.ai/v1/systemone"` | Complete HTTP API URL, not a base URL. |
| `model` | `"jev-latest"` | Provider-specific remote model identifier. |
| `systemPrompt` | built-in evaluator policy | Full evaluator instructions for both protocols. `/auto-mode` opens it in a multiline editor; empty values are rejected. Replacing it can weaken protection. |
| `apiKey` | `""` | Write-only bearer credential; no key is bundled. |
| `timeoutMs` | `20000` | Remote deadline including the response body; integer 1–25,000 milliseconds. |
| `minConfidence` | `0.8` | Minimum reported confidence for allow, from 0 to 1; not a measured accuracy guarantee. |
| `maxInputChars` | `100000` | Maximum serialized input; integer 1–1,000,000 characters. Larger inputs block rather than truncate. |

Endpoints must use HTTPS, except HTTP is allowed for loopback development endpoints. URL user information and fragments are rejected. Redirects are not followed, preventing bearer credentials from being forwarded to a redirect target. Changing provider chooses that protocol's endpoint/model defaults unless explicitly supplied. Changing provider or endpoint clears the saved key unless a replacement `apiKey` is supplied with the change. Environment keys are bound to the environment-designated provider/endpoint, not forwarded to a new runtime destination.

`systemPrompt` is the complete evaluator policy, not an extra instruction appended to the built-in policy. The repository ships the reviewed default; `/auto-mode` edits it in a multiline editor and the config file can set it directly. The same text is used as native JEV question instructions and as the OpenAI-compatible system message. A custom prompt can remove or weaken safeguards, so changing it is an explicit operator decision.

### Config file and environment

The default file is `~/.config/auto-mode/config.json`; `AUTO_MODE_CONFIG` selects another path. Every key is optional. Startup reads validated file values, then validated environment overrides. Invalid configuration is reported without echoing secrets. Runtime patches reject invalid settings. Saved files use owner-only permissions on POSIX, but credentials are still plaintext, not encrypted storage.

| Environment variable | Overrides |
| --- | --- |
| `AUTO_MODE_CONFIG` | Config file location |
| `AUTO_MODE_PROVIDER` | `provider` |
| `AUTO_MODE_ENDPOINT` | `endpoint` |
| `AUTO_MODE_MODEL` | `model` |
| `AUTO_MODE_API_KEY` | `apiKey`, only for the provider/endpoint designated by the startup environment |
| `TYPESAFE_API_KEY` | Fallback credential only for the native provider at the official `https://api.typesafe.ai` origin |

Runtime patches apply to the current effective configuration and override startup environment values until restart. At the next launch, validated environment overrides apply again; do not assume changing a saved value overrides them. Environment-only credentials are not written to disk by unrelated settings changes. The public settings view replaces `apiKey` with `apiKeyConfigured`; keys are not returned by settings or status output or intentionally included in logs and errors. That redaction does not remove secrets already present in prompts or tool content sent for evaluation.

`AUTO_MODE_API_KEY` is bound to `AUTO_MODE_PROVIDER` (default `typesafe`) and `AUTO_MODE_ENDPOINT` (the provider's built-in endpoint for `typesafe`). To use it with a custom endpoint, set both endpoint and key explicitly; `custom` has no built-in URL. A saved explicit key is the other option. `TYPESAFE_API_KEY` never supplies credentials to a custom destination.

## Operational limits

- The decision runtime runs inside the harness process. It has no local network listener, but configuration, credentials and in-memory session state are available to code running in that process. Protect the harness and installed extensions.
- omp's own tool approval and deny policies remain in force. Auto Mode can block a call, not override a harness denial. Remote deadlines are capped at 25 seconds and adapter gates at 26 seconds to fit omp's default 30-second handler timeout. A handler terminated by the harness cannot enforce its result.
- Headless and subagent sessions use the same blocking behavior; there is no dialog-dependent fail-open mode. Authorization follows the current branch, not a union of sibling conversations. Child agents inherit root authorization only through registered same-process parent ancestry; missing ancestry blocks. Text in a child session is subordinate assignment context, not new direct-user authority, so it cannot override ancestor restrictions. Grant broader delegated permission in the parent session rather than assuming cross-session message order.
- Public historical user-message attribution is not cryptographic proof of a human author. A trusted extension can submit user-attributed messages through the harness API. Protect the harness and installed extensions.
- Only text exposed through the supported adapter is evaluated. Images, binary data, hidden runtime state and operations outside hooked tool paths are not covered. Checks do not sandbox subprocesses or continuously monitor a tool after approval.
- Remote latency, service availability and cost affect every checked step. A configured key is not proof that it is valid or that the service is healthy.
- Finite live-model checks and protocol tests do not establish general detection accuracy. A model can still permit an attack or unnecessarily block legitimate work; a confidence threshold trades availability against caution, not against a guaranteed error rate.

## Development

```bash
npm test
npm run test:e2e
```

Tests target observable configuration, protocol, session and adapter behavior. Simulated provider responses do not measure native JEV accuracy. See [Architecture](docs/architecture.md) for the module boundaries.

Work happens on `dev`. `main` changes only through pull requests from `dev`; a source-changing merge to `main` publishes a release. The release workflow runs the normal tests and packs the source project. It does not require paid provider access merely to create a package.

## License

Free to use, modify and redistribute, as long as the original author stays credited and the project is not presented as someone else's own. See [LICENSE](LICENSE).
