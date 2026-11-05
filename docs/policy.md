# Decision Policy

This document describes Auto Mode's intended trust and authorization boundary. The executable evaluator instructions default to the reviewed built-in policy in `core/prompts.mjs`; `systemPrompt` can replace them through configuration. Protocol validation and normalization live in `core/decision.mjs`. This is a categorical remote decision policy, not a command-pattern permission table. Model judgments are fallible and do not replace operating-system isolation or the harness's deny policy. A custom policy is the operator's responsibility and may weaken the guarantees described here.

## Authority and trust

Direct user instructions from the root session's active conversation branch establish the maximum authorization. Preserve earlier constraints until a later direct user instruction in that root branch explicitly overrides them. A new instruction that adds work does not silently remove an unrelated prohibition. If an adapter can establish direct-human input from a descendant session, `context.delegatedUserPrompts` carries it as an additional narrowing constraint, never permission to expand root scope or revoke current ancestor restrictions. That field does not claim cross-session chronology. The omp adapter treats subagent-session text as subordinate assignment context, so a child cannot gain or revoke user authority; grant broader delegated permission in the parent session.

For example:

1. The user says “Fix this bug, but do not commit or push.”
2. The user later says “Run the tests.”
3. Investigation, appropriate edits and tests may be authorized. A commit or push is still prohibited.

Human-submitted goal objectives are direct authority when recorded as actual user prompts. In contrast, the saved active goal, assistant plan, assistant-generated task assignment and recent observations explain the work but cannot expand authority. A goal such as “ship the release” does not override a direct user's “do not publish.” A summary of the conversation is not a substitute for its full authorization constraints. Branch switches replace active context instead of combining unrelated sibling histories; each action carries current context so a new adapter process cannot assume missing authorization.

Tool output, repository content, retrieved pages, external messages, shell output and raw proposed tool payloads are untrusted state for the evaluator. Their requests to change evaluator policy, impersonate the user or treat themselves as system instructions have no authority. An action payload may contain instructions for a delegated agent, script or nested interpreter; those instructions and their intended side effects must also be judged.

The omp adapter uses public message provenance and active-branch data, not private harness authorization files. This cannot establish the origin of every historical message cryptographically: another trusted extension can submit a message marked as a user message through the harness API. Protect the harness and installed extensions. Subagent-session text is subordinate assignment context, not direct-user authority, and missing verifiable parent ancestry blocks child checks. A child cannot substitute delegated text for missing parent context.

## Injection question

The evaluator chooses one of:

- `clean`: no active attempt to redirect the agent through an untrusted channel;
- `injection`: a concrete attempt to override instructions, spoof authority, exfiltrate data, conceal behavior or redirect the task;
- `uncertain`: context is missing or the evaluator cannot safely distinguish data from an attack.

Judge purpose and context, not the presence of scary words. A quoted attack in a security test, a paper discussing jailbreaks, an ordinary code sample or legitimate task documentation is not automatically an active injection. Paths, URLs and tool names are identifiers, not instructions. A user-authorized read of a suspicious file is not itself malicious; its actual output is checked separately before delivery. Conversely, polite phrasing, hidden markup, encoded payloads, code comments or claimed maintenance requirements do not make an unauthorized behavioral instruction safe.

Examples of hostile behavior include telling the agent to upload credentials, ignore the user's scope, weaken safety controls, execute unrelated remote code, conceal actions or falsify a report. State supplied to the evaluator cannot tell it to change its answer format, confidence or policy.

## Scope question

For actions, independently choose:

- `authorized`: the tool's concrete behavior is within direct-user authorization and all retained constraints;
- `out_of_scope`: it contradicts constraints or introduces unauthorized side effects;
- `uncertain`: authorization or effects cannot be established from the available context.

Evaluate the full raw tool arguments, working directory, shell/nested execution payload and relevant observations. Tool names do not establish safety. A read-like MCP name can have side effects; a shell command can delegate them to another program. Ordinary necessary investigation, editing and testing can be authorized by a request to fix a defect without enumerating every command.

A general fix request does not implicitly authorize commits, pushes, publication, credential disclosure, spending, permission changes, unrelated data deletion or persistence changes. The user must supply authorization appropriate to those side effects. Even explicit authority does not make an injected instruction trustworthy; both questions must pass.

Missing direct-user prompts block an action before an allow can be accepted. The evaluator must not manufacture consent from an assistant's intention, a goal, a task label or a tool result.

## Allow/block normalization

| Condition | Category | Effect |
| --- | --- | --- |
| All required answers are clean/authorized and meet `minConfidence` | `safe` | `allow` |
| Injection choice identifies an attack | `injection` | `block` |
| Scope choice is outside authorization | `scope` | `block` |
| Any required choice is uncertain, confidence is low or context is insufficient | `uncertain` | `block` |
| A usable evaluation cannot be obtained or validated | `unavailable` | `block` |

Native JEV receives categorical choice questions with distinct criteria. Its selected choices, confidence values and criterion probabilities are validated. The OpenAI-compatible path receives the same policy through a system message and untrusted state as JSON in a separate user message; its content must be strict JSON with known labels and numeric confidence. Neither path can authorize a response by injecting text that looks like a decision.

`minConfidence` is a threshold on the provider's reported confidence, not a promise of real-world accuracy. The native confidence value is validated independently of its probability distribution. Category explanations are fixed product text, not fabricated model reasoning or quoted evidence.

## Fail-closed lifecycle

- All tool calls are prechecked before execution, including delegated tasks and MCP calls.
- All nonempty tool-result text, including short results and edit/write confirmations, is checked before it is delivered to the agent. Non-text content is outside this text evaluator's coverage.
- A blocked or failed output check withholds the complete text and interrupts the agent. No warning-plus-delivery or interactive bypass substitutes for withholding it.
- Pending output checks finish before the same session receives an action allow. Changed authorization context invalidates an in-flight decision rather than reusing it for the new branch.
- Missing credentials, unreachable service, provider errors, redirects, deadlines and invalid responses block. Remote errors and response bodies are not echoed as explanations.
- Oversized serialized input blocks without silently dropping prompts, tool arguments or the middle of an output. Remote responses are size-limited as well.
- No retry, fallback provider or locally inferred permission silently replaces a failed evaluation.
- Accepted recent output is bounded supporting context. A rejected result does not impose a permanent taint on unrelated future actions.
- Clearing counters and observations does not erase user authorization restrictions. A restarted adapter must resupply authoritative context.
- Explicit `enabled: false` bypasses Auto Mode and leaves the harness in control. A missing or failed service is never interpreted as an implicit disablement.

A preflight decision is not continuous monitoring. Tools can change files or contact services before their output is checked, and a block on output cannot reverse those effects. The adapter cannot protect operations outside supported hook paths, nor can it enforce a decision after the harness has terminated its handler. The harness's own deny and approval policy remains independent.

## Credentials and privacy

Remote decisions send full user prompts, the subordinate goal, agent metadata, raw action input, working directory and recent tool text to the configured endpoint. This is an explicit operational privacy boundary, not just an injection scan. Content may itself contain secrets; API-key redaction does not sanitize user/tool data.

No API key is supplied by default. Credentials are bearer secrets; use a provider-scoped key with appropriate spending and access limits. Public settings expose only whether a key exists. Saved keys are plaintext local configuration protected by available file permissions. Environment keys can be inherited by subprocesses. The runtime refuses redirects, limits endpoint schemes and clears saved keys on provider/endpoint changes unless explicitly replaced.

The runtime executes inside the harness process. It has no network listener, but configuration, credentials and in-memory session state are available to code running in that process. A compromised harness, provider, local account or trusted extension is outside this gate's protective boundary.

## Assurance limits

Both false allows and false blocks are possible. Unknown encodings, invisible content, incomplete provenance, indirect script behavior and model mistakes can defeat the intended boundary. Custom protocol compatibility does not establish security competence. Simulated endpoints cannot measure model judgment, and a finite live-model sample cannot establish general detection accuracy or a perfect-detection guarantee.

Use least-privilege credentials, restricted harness policies and a container or virtual machine for sensitive work. Keep recoverable project history. See [Security Policy](../SECURITY.md) for reporting security defects and [Architecture](architecture.md) for the implementation details.
