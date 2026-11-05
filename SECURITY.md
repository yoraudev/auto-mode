# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately using the repository's **Security** tab and **Report a vulnerability**, rather than opening a public issue. Include:

- what an attacker can do and the trust boundary crossed;
- reproducible steps or a minimal proof of concept;
- release version, operating system, omp version and extension configuration;
- provider protocol, model identifier and relevant sanitized responses;
- whether the action was blocked before execution and whether result text reached the agent.

Remove real API keys, user prompts, private code, account identifiers and other sensitive information before sharing a report. Do not send a live credential as a reproduction artifact. Allow the maintainer reasonable time to investigate and release a fix before public disclosure.

Only the latest release receives security fixes.

## Intended protection

Auto Mode evaluates tool actions against direct-user authorization and checks tool-result text for prompt injection. Earlier user constraints survive subsequent task additions, goal changes, clearing decision statistics and adapter restarts when the adapter resupplies current context. A subordinate goal, assistant plan, child-agent assignment, retrieved file or tool output must not grant new authority.

Enabled Auto Mode blocks when evaluation is unavailable, uncertain or invalid. A blocked output must be withheld before the agent receives it. There is no interactive bypass of a blocked decision, and the harness's own deny policy remains in force. See [Policy](docs/policy.md) and [Architecture](docs/architecture.md) for the intended behavior and supported interfaces.

Examples worth reporting include:

- an enabled action proceeding because the runtime or provider failed, returned malformed data or did not have an API key;
- an adapter delivering text after its output check blocked, timed out or failed;
- an earlier user prohibition being lost through a branch change, restart or clearing statistics;
- a model-authored or saved goal without a direct human prompt, an assistant message or ordinary untrusted tool result being accepted as new user authorization;
- wrong-session or stale-context decisions being applied to another pending action;
- a public settings view, log or error exposing a configured bearer key;
- a redirect or destination change forwarding a saved key without explicit replacement;
- an in-process guard bypass that applies a stale, missing or unverified authorization context;
- an Auto Mode allow overriding a harness denial.

A particular adversarial prompt that a model misses can also be reported with sanitized context. Distinguish a model judgment failure from an enforcement, provenance or protocol-validation defect; both are useful to understand, but they may require different mitigations.

## Privacy and credential boundary

The runtime sends user prompts, subordinate goal, agent metadata, raw tool arguments, working directory and recent tool-result text to the configured endpoint. These can include secrets or proprietary data. Provider terms, retention, training use, billing and account controls are the operator's responsibility. Do not configure a destination that is not approved for the data involved.

No key is bundled. The native default uses Typesafe JEV; a custom decision service uses its own endpoint, model and bearer key. JEV is not available through the custom OpenAI-compatible option. The service receiving the evaluation sees its content; a malicious or compromised provider can return misleading decisions. HTTPS protects transport, not the provider's behavior.

Public settings never return `apiKey`; they expose `apiKeyConfigured`. Logs and error responses are sanitized rather than echoing raw provider failures. Redaction of the configured bearer credential does not scrub secrets from prompts or raw tool content. A user who includes a credential in source or output may send it to the evaluator as part of that content.

Saved keys remain plaintext in local config. POSIX owner-only file permissions reduce accidental access, not account compromise; filesystem ACLs and process isolation still matter. Environment keys may be visible to inherited subprocesses. Prefer scoped credentials with spending limits, protect the local account and rotate any key that may have leaked. Keys typed into a settings input can be visible while entering them even though subsequent displays are redacted.

Provider/endpoint changes clear saved keys unless explicitly replaced. `AUTO_MODE_API_KEY` applies only to the startup environment's provider/endpoint (official provider defaults when omitted); a custom destination needs an explicitly matching environment endpoint or a saved key. `TYPESAFE_API_KEY` is restricted to the official native Typesafe origin. Redirects never receive forwarded bearer credentials.

## Known limitations

- **Imperfect model judgment.** Injection detection and scope decisions can be wrong in either direction. Reported confidence is not a measured accuracy guarantee. Finite live-model checks do not establish general detection accuracy, and simulated responses do not measure native JEV judgment. A custom `systemPrompt` can remove safeguards present in the reviewed default; it is not covered by the default security properties or tests.
- **Not a sandbox.** Allowed tools execute with the agent's access. The gate does not restrict their syscalls, continuously inspect subprocesses or undo side effects that occurred before an output block.
- **Text and hook coverage only.** Images, binary data, hidden runtime state and operations outside supported adapter hooks are not evaluated. A handler terminated or timed out by the harness cannot enforce its decision.
- **Trusted harness process.** The runtime has no network listener, but it shares the harness process. Code running there can change configuration, disable the extension, tamper with session context or read the saved key. Protect the harness and installed extensions.
- **Harness provenance limits.** Public message attribution is not cryptographic proof of a historical human author. Another trusted extension can submit user-attributed messages through the harness API. Protect installed extensions and the harness itself.
- **Availability, latency and cost.** Remote failures block work while enabled; a key being configured is not a provider availability check. Each checked step can incur remote latency and charges.
- **Explicit disablement.** `enabled: false` deliberately bypasses Auto Mode. Output read or actions taken while disabled are not retroactively checked.

Keep independent harness restrictions, least-privilege credentials and recoverable history. For untrusted projects or sensitive accounts, use a container or virtual machine with only the access the task needs.
