# Auto Mode

## Tech Stack

- **Language:** JavaScript ES modules.
- **Runtime:** Node.js 22 or newer for the shared runtime; the host harness's extension runtime for adapters.
- **Layout:** `core/` for configuration, evaluator prompts, remote protocols and the in-process session guard; `adapters/shared/` for the shared adapter runtime and UI metadata; `adapters/omp/` for omp hooks; `test/` and `e2e/` for boundary tests.
- **Decision providers:** Typesafe's native JEV System One API by default; a configurable custom endpoint using OpenAI-compatible chat completions. No key is bundled and no local inference is performed.
- **Transport:** authenticated HTTPS from the in-process runtime to the chosen remote provider, with loopback HTTP allowed for development endpoints. No local service is started.
- **omp adapter:** Plain JavaScript extension using action/result hooks and `/auto-mode`, loaded without a build step.
- **Tests:** `node:test` for consumer-visible behavior and an in-process integration runner against a loopback provider fixture.
- **CI/releases:** GitHub Actions; `dev` is the working branch, `main` receives merges only, and a source-changing merge to `main` publishes a release.

## Security Invariants

- Check every action before execution against complete root direct-user authorization, retaining previous constraints. A human-submitted goal objective is authority through its user prompt; a saved goal, assistant plan or child-session text is subordinate context and cannot expand ancestor permission.
- Check exposed tool-result text before delivery. Withhold blocked text and interrupt the agent; do not add a warning and pass hostile content through.
- Fail closed on unavailable, uncertain, missing-context, oversized or malformed evaluations. Explicit disablement is the only bypass. An allow never overrides the harness's own denial.
- Keep evaluator policy separate from hostile state. The default `systemPrompt` is the reviewed baseline; a custom replacement can weaken protection. Use the actual native choice protocol for JEV and strict JSON for the custom OpenAI protocol; do not fabricate model reasoning or native accuracy claims.
- Keep API keys write-only through public APIs and redact errors. Provider/endpoint changes must not silently forward stored credentials. Document that prompts, code and raw tool content are sent to the selected endpoint and that local secrets remain plaintext.
- Test observable boundaries rather than source-text structure. Paid-provider accuracy is not established by simulated responses.

## Project Rules

- Work happens on `dev`. `main` is protected and changes only by merging a pull request from `dev`; a source-changing merge publishes a release. Never push to `main` directly. Keep `dev` after merging.
- Every repository file is written in English: code, identifiers, user-facing strings, documentation and commit messages.
- Commit messages follow Conventional Commits: `type(scope): description`, with types such as `feat`, `fix`, `chore`, `docs`, `refactor`, `test` and `ci`. Mark breaking changes with `!` after the type. Keep the subject short and descriptive; write details in the body.
- Commits, pull requests and other published repository material carry only the repository owner's name and email. Never add AI/tool attribution, `Co-Authored-By` trailers, generated-with lines or assistant authorship.
- Do not write code comments. Every handwritten code/config file, including YAML and `.gitattributes`, stays free of comments.
- Update every Markdown file that references added, changed or removed behavior in the same change. Keep README, architecture, policy and security limitations aligned with real interfaces.
