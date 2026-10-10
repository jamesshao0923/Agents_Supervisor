# Codex app-server adapter

The adapter handles JSONL RPC on an injected `LineTransport`. It never starts a child process, writes global Codex settings, logs in, or retries a request. The supervisor owns process groups, budgets, authorization, lifecycle, and durable storage.

Before starting the app-server, the caller probes `codex --version` and generates local schemas with `codex app-server generate-json-schema --out <local-evidence-directory>`. `inspectProtocol(version, directory)` verifies the reviewed 0.153.4 schema digest. The checked-in baseline contains only relevant schema filenames and their combined canonical JSON digest. Changed versions or schemas require review. Runtime objects retain unknown fields; unknown status values never imply completion.

After reviewing a vendor change, generate the baseline with `node dist/packages/executor-codex/generate-baseline.js <local-evidence-directory> <reviewed-version>` from the repository root. This generator uses the production canonicalizer, including JavaScript JSON number normalization (`0.0` becomes `0`). Compare and review the resulting source diff before accepting a new baseline. The compatibility checker never rewrites its baseline automatically.

Connect, call `initialize()`, then `listModels()` to inspect advertised input modalities and reasoning efforts. `startThread()` creates an independent session; `readThread()` and `resumeThread()` explicitly access an existing session. `startTurn()` accepts text and absolute local image paths. Missing advertised modalities remain unknown. `interruptTurn()` acknowledges a request and does not establish that work or its process has stopped.

Every incoming line reaches the awaited `onRawEvent` callback before any reduction, response correlation, or server request handling. Persistence failure closes the protocol connection. Received deltas retain sequence order; equal text is not deduplicated because repetition can be legitimate. Request IDs correlate responses; duplicates and late responses remain raw evidence. Notifications without vendor IDs cannot be safely deduplicated by content. The supervisor owns persisted event IDs and ordering across connections.

Server approval and input requests emit visible waiting events. An optional `onServerRequest` handler returns a result or explicitly defers by returning `undefined`, followed by `respond()` or `rejectServerRequest()`. Without a handler, requests receive an unsupported-method error. Approval policies and process-scoped config overrides must come from the caller's authorization policy. No approval is granted by default.

Timeout, write failure, disposal, protocol failure, or disconnect reject in-flight requests with `UnknownOutcomeError`. Callers must reconcile thread/turn and process facts before deciding on another action. Token counts preserve vendor input, cached input, output, reasoning output, and total separately; cached input is not added to input and tokens do not assert billed monetary cost. Terminal classification comes only from known turn statuses; `error.willRetry` remains a diagnostic fact.

Protocol unit inputs in `tests/unit/executor-codex.test.ts` exercise the production implementation but do not count as vendor-live coverage. P2 acceptance also requires real managed-process, Codex, task artifact, cancellation, reconnect, and image-input evidence.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
