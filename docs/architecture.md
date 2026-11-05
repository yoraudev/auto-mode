# Architecture

Auto Mode keeps harness-specific hooks thin and shares the security logic between adapters. The current flow is in-process:

```text
omp hooks -> adapters/omp -> adapters/shared/runtime -> core/guard -> core/decision -> configured endpoint
```

There is no local listener or separate service. The guard retains current authorization context, recent accepted text and pending output checks in memory inside the harness process. A future adapter imports the same `core/` and `adapters/shared/` modules and supplies only its event mapping and UI.

## Modules

| Path | Responsibility |
| --- | --- |
| `core/config.mjs` | Defaults, validation, file/environment configuration, safe runtime changes and public secret redaction. |
| `core/prompts.mjs` | Evaluator policy, categorical questions and protocol-specific output contracts. |
| `core/decision.mjs` | Native Typesafe and custom chat-completions transports, bounded response parsing, deadlines and normalized decisions. |
| `core/guard.mjs` | In-process session context, ordered output checks, action decisions and inherited authorization. |
| `adapters/shared/runtime.js` | Adapter-facing runtime, result validation and settings calls. |
| `adapters/shared/settings.js` | Shared setting labels and option metadata. |
| `adapters/omp/` | omp event hooks, active-branch context capture and settings UI. |
| `test/` | Consumer-visible protocol, configuration, guard and adapter tests. |
| `e2e/` | In-process guard and remote-provider integration scenario. |

No build step is required. The runtime and adapters use JavaScript ES modules. Node.js 22 is used by the release workflow.

## Evaluation input

An action carries the original tool name and raw arguments, not a lossy command/path classification:

```json
{
  "kind": "action",
  "context": {
    "userPrompts": ["Fix the bug. Do not commit.", "Run the relevant tests."],
    "delegatedUserPrompts": [],
    "goal": "Fix and verify the bug",
    "assignment": null,
    "runtimeId": "12345",
    "sessionFile": "/sessions/current.jsonl",
    "parentSessionFile": null,
    "agent": {
      "kind": "main",
      "id": "agent-id",
      "name": "Main"
    }
  },
  "request": {
    "tool": "bash",
    "input": {"command": "npm test"},
    "cwd": "/project"
  },
  "observations": [{"tool": "read", "text": "Recent accepted tool output"}]
}
```

`userPrompts` is the root session's direct-human history in branch order. `delegatedUserPrompts` is a guard field for descendant direct-human requests when an adapter can establish that provenance; those groups can narrow scope, never expand ancestor permission, and do not claim cross-session chronology. The omp adapter carries subagent-session text as subordinate `assignment` context instead, so a child cannot gain or revoke user authority. `goal`, `assignment` and `agent` may be `null`; an agent identity may include `parentId`. `runtimeId` is the adapter process identifier as a string. `sessionFile` comes from public `getSessionFile()` or is `null`. `parentSessionFile` comes from public `getHeader().parentSession` when it is path-like, otherwise `null`; these paths identify lineage without reading private authorization files. A child assignment is model-authored task context, not direct-user authorization.

Output evaluations use `kind: "output"` and `output: {tool, text}` instead of `request`, with the same authorization context. Action evaluations also receive bounded recent accepted observations, not a complete audit log. The entire serialized input is compared with `maxInputChars`; oversized input blocks without silent truncation. No model-generated summary replaces authoritative user prompts.

## Decision result

Enabled checks return:

```json
{
  "effect": "allow",
  "category": "safe",
  "reason": "A fixed explanation of the decision category",
  "confidence": 0.95
}
```

| Condition | Category | Effect |
| --- | --- | --- |
| All required answers are clean/authorized and meet `minConfidence` | `safe` | `allow` |
| Injection choice identifies an attack | `injection` | `block` |
| Scope choice is outside authorization | `scope` | `block` |
| A required answer is uncertain, confidence is low or context is insufficient | `uncertain` | `block` |
| A usable evaluation cannot be obtained or validated | `unavailable` | `block` |

Transport, configuration, timeout, oversized-response and malformed-response failures normalize to an unavailable block. Error messages do not echo provider response bodies, raw credentials or arbitrary exception text. There are no remote retries or fallback providers. Category reasons are fixed product explanations, not model-generated evidence.

The guard also validates a decision returned by an injected runtime or provider adapter; an unknown effect, category, reason or confidence blocks instead of allowing.

## Remote transports

### Native Typesafe

A bearer-authenticated POST sends the complete input in `state` and two native System One choice questions:

```json
{
  "model": "jev-latest",
  "state": {
    "kind": "action",
    "context": {},
    "request": {},
    "observations": []
  },
  "questions": {
    "injection": {
      "type": "choice",
      "instructions": "Evaluator policy and injection question",
      "criteria": {
        "clean": "No active injection",
        "injection": "Active injection",
        "uncertain": "Insufficient evidence"
      }
    },
    "scope": {
      "type": "choice",
      "instructions": "Evaluator policy and authorization question",
      "criteria": {
        "authorized": "Within user authorization",
        "out_of_scope": "Outside user authorization",
        "uncertain": "Insufficient evidence"
      }
    }
  }
}
```

This illustrates the protocol shape; actual question policy comes from `core/prompts.mjs`, and real `state` is the complete evaluation input. Output checks omit the scope question. The response supplies `answers.injection` and, for actions, `answers.scope`, each with `type: "choice"`, a known `choice`, a numeric `confidence` and a `probabilities` object covering its criteria. Probabilities must be finite values from 0 to 1, approximately sum to 1 and support the selected highest-probability choice. Confidence is validated independently: it is not assumed equal to the selected probability. An allow must meet `minConfidence` for every required answer.

JEV's native choice response does not generate free-form reasoning. Auto Mode does not invent quotations or passages to explain it. See the [official protocol](https://docs.typesafe.ai/api/system-one.md).

A gateway accepting the same JEV `state`/question-map protocol can use `provider: "typesafe"` with its own complete endpoint URL and model identifier. The protocol name does not restrict the endpoint to Typesafe's host.

### Custom OpenAI-compatible chat completions

Selecting `custom` clears the endpoint and model defaults; both must be supplied for the destination. JEV is not available through this option; `typesafe` is its native protocol.

A bearer-authenticated POST sends `model`, `messages` containing system evaluator policy and a user message with `JSON.stringify(input)`, `temperature: 0` and `response_format: {"type":"json_object"}`. The JSON string in `choices[0].message.content` must have:

- `injection`: `clean`, `injection` or `uncertain`;
- `scope`: `authorized`, `out_of_scope` or `uncertain`, required for actions;
- `confidence`: finite number from 0 to 1.

No code-fence extraction or prose recovery is performed. Output checks do not require scope. Both protocols use the same final category/effect normalization. Supporting the protocol does not qualify a model as a reliable security evaluator.

### Network and credentials

Endpoints must use HTTPS except loopback HTTP for local integration/development. URL user information and fragments are rejected. Redirects are rejected rather than forwarding bearer authentication. The request deadline includes reading the response body, and response size is bounded before JSON processing.

`AUTO_MODE_API_KEY` applies only to the provider/endpoint designated by the startup environment: `AUTO_MODE_PROVIDER` defaults to `typesafe`, whose endpoint has a built-in default, while `custom` requires an explicit `AUTO_MODE_ENDPOINT`. A custom file-only destination needs an explicit saved key or a matching `AUTO_MODE_ENDPOINT` plus `AUTO_MODE_API_KEY`. Environment credentials are not forwarded after a runtime target change. `TYPESAFE_API_KEY` is a fallback only for native Typesafe at the official HTTPS origin. The runtime has no bundled key and does not discover credentials from unrelated harness settings.

## Session guard

`core/guard.mjs` is created once by the adapter runtime. It validates and stores the current context per session, retains bounded observations and serializes output checks before actions:

- A context update advances its version; an in-flight result for obsolete context is blocked instead of granting permission for a different state.
- An action waits for pending output evaluations in the same session. Only an allowed output enters observations. Blocked or unavailable text never becomes ordinary context.
- A settings change invalidates an in-flight check that started against the previous configuration.
- The guard registers root authorization with `runtimeId`, agent identity and the exact public session-file path. A child resolves `runtimeId` plus `parentSessionFile` against a registered parent's exact `sessionFile`, falling back to a sticky `runtimeId` plus `agent.parentId` association. Missing or cyclic ancestry blocks.
- Root prompts establish the maximum authorization. Descendant direct prompts can narrow, never expand or revoke ancestor permission. The omp adapter keeps child-session text in subordinate assignments instead.
- Clearing counters and observations does not erase user authorization context. The adapter resupplies the current branch at session boundaries and on every action.

The guard is in-memory. A new harness process starts with no session state and must provide context before an action can be allowed.

## Configuration lifecycle

`core/config.mjs` exports `DEFAULTS`, `SETTINGS`, `configPath`, `loadConfig`, `validate`, `saveConfig` and `publicConfig`. `SETTINGS` describes runtime-editable fields. The [README settings table](../README.md#settings) lists fields, defaults and environment overrides.

`systemPrompt` defaults to the built-in `POLICY` from `core/prompts.mjs`. It is a complete replacement, not an appended instruction. It must be nonempty, at most 50,000 characters and free of null characters. `core/decision.mjs` composes the selected policy with the injection question, scope question or chat-completions JSON contract at request time, so both protocols use the same configured text. A custom policy is operator-controlled and can weaken the reviewed safeguards.

Startup ignores invalid file/environment values with sanitized warnings. Runtime patches reject invalid fields or values. `timeoutMs` is an integer from 1 to 25,000; `maxInputChars` is an integer from 1 to 1,000,000; `minConfidence` ranges from 0 to 1. These are input validation limits, not promises about provider capacity.

Provider changes apply matching endpoint/model defaults unless the patch explicitly provides them. Provider or endpoint changes discard a saved key unless the same patch explicitly supplies a replacement. Invalid startup provider/endpoint settings also discard the associated key instead of risking forwarding it to a fallback destination. Explicit environment keys apply only to their environment-designated destination.

`saveConfig(patch, env, current)` applies a patch against the effective current configuration and returns the applied configuration. Sequential runtime changes therefore retain current endpoint overrides and credential clearing rather than reloading stale startup values. Runtime patches override startup environment settings until restart; the next launch applies validated environment overrides again. Persistence records effective non-secret settings and explicit replacement keys, retaining an existing stored key only for its unchanged matching target. It never persists an environment-only credential.

Config is stored by default at `~/.config/auto-mode/config.json`, or `AUTO_MODE_CONFIG`. Saved credentials are write-only through public settings and use owner-only file permissions on POSIX. This is still plaintext local storage; account compromise and inherited environment access are outside that protection.

## Adapter lifecycle and enforcement

The omp adapter rebuilds current-branch context for each call. It preserves the direct-input event text it receives from fresh interactive/RPC input through public custom entries, synchronizes on `before_agent_start` without promoting its transformed prompt, and reads saved goal state plus `goal_updated` as subordinate context. Human objectives submitted through `--goal` or the goal editor are authorized through their actual user-attributed prompt, not through `goal_updated` alone. Earlier trusted extensions can rewrite an input event before Auto Mode receives it; capture is not a guarantee of original physical keystrokes.

Each `tool_call` sends raw input before execution. Every nonempty tool-result text is checked before delivery, including short results and edit/write confirmations. A blocked result is replaced by a safe withheld notice and the agent is aborted. The adapter does not ask to bypass the current decision. Headless sessions use the same gate. The provider deadline is at most 25 seconds and the adapter's outer deadline is 26 seconds, within omp's default 30-second handler timeout.

The harness's own approval policy still applies; an allow from Auto Mode cannot override a harness denial. Enforcement depends on supported hooks completing: host termination, handler timeouts, unhooked operations and non-text output are not sandboxed by this extension.

## Policy and assurance

[Policy](policy.md) describes the intended injection and authorization boundary. Permanent tests cover observable protocol validation, config redaction, authority preservation, blocked calls and withheld output. Integration scenarios use a local loopback provider fixture without sending data to a paid service. Simulated responses do not measure native JEV judgment, and finite live-model samples do not establish general detection accuracy. Neither yields a perfect-detection guarantee.

## Releases

The existing `dev` to `main` strategy is unchanged. `.github/workflows/release.yml` runs on source-changing pushes to `main` and supports manual dispatch only on `main`. It installs dependencies, runs `npm test`, computes the next patch version from matching tags and publishes the packed source. `dev` pushes do not publish releases. The repository package version is `0.2.0`; release packaging computes its own patch version from that minor line.