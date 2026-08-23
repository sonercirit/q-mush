# Provider and Model Protocols

Companion project memory to `AGENTS.md`. Read this before changing provider
discovery, requests, streaming, caching, retries, or model capability handling.

## Architecture

- `openai.ts`, `openrouter.ts`, `generic-provider.ts` implement model
  connections. Generic providers store normalized base URLs, optional key, and
  an `apiFormat` toggle: the default OpenAI format uses `/models` plus streamed
  `/chat/completions`; the Anthropic format sends `x-api-key` and
  `anthropic-version` to `/models` and streamed `/messages`
  (`anthropic-request.ts`, `provider-stream-anthropic.ts`; images/PDFs map to
  native blocks). Credentials in `provider_credentials` use per-record
  AES-256-GCM encryption; APIs expose metadata only; one credential can be the
  user's default across providers. Shared: `provider-credentials.ts`,
  `connected-account-oauth.ts`, the `solid/provider-*` client modules.
- Measure cache hits against the cacheable prefix (total input dilutes with
  fresh tool output); persistent shortfalls are defects, while a lone miss is
  noise to ignore from observed late cache writes or documented 128-token block
  granularity. Codex sockets remain open per run (cache-neutral), reconnect
  after failure, close afterward. UI rates divide by summed input minus final
  request (summary) or prior step's input (per step), capped at 100%, counting
  fully reported steps. OpenAI/Codex requests carry the session ID as
  `prompt_cache_key` and the Codex `session_id` header (cache routing); that
  surface rejects `prompt_cache_breakpoint`/`prompt_cache_retention`. OpenRouter
  and Anthropic-format requests mark 1-hour `cache_control` points on the system
  prompt, transcript tail, and Anthropic tool definitions
  (`provider-prompt-cache.ts`); OpenAI rejects them, generic OpenAI-format
  endpoints get neither markers nor `prompt_cache_key` (Ollama rejects array
  content; strict servers reject unknown fields). Requests send catalog
  `max_tokens` (`agent_sessions.max_output_tokens`), omitted when discovery
  reported none — the API requires it, proxies don't; the
  context-window-exceeded beta degrades pre-4.5 overshoots to a stop reason.
  Length stops save a nonreplayed `error` notice (`AgentModelStep.truncation`).
  Null limits refresh lazily (`session-current-model.ts`) only while its
  credential stays attached, propagating stops, not degrading; generic
  reassignment nulls them to re-probe, else they snapshot like context sizes.

## Operational Gotchas

- **Transport and catalogs:** OpenAI API-key and OAuth requests prefer Responses
  WebSockets, falling back to HTTP streaming; OpenRouter and generic endpoints
  stream chat completions, Anthropic-format ones Messages events. OpenAI OAuth
  refreshes its token before expiry. Sessions need an explicit model ID.
  Catalogs: OpenAI `/v1/models`, OpenRouter `/api/v1/models/user`, ChatGPT Codex
  `/models`, or generic `/models`; Anthropic-format catalogs read
  `display_name`, `max_input_tokens`, `max_tokens`, the `capabilities` tree
  (`agent-model-discovery-anthropic.ts`: effort and adaptive-thinking support
  are independent; modalities come only from `image_input`/`pdf_input` leaves),
  page via `has_more`/`last_id` at `limit=1000` with stale-cursor and page-count
  guards, probing its OpenAI-style listing only where capabilities left efforts
  unknown. Codex parsing retains streamed output-text and function-call argument
  deltas since completed events may omit `output`.
- **Reasoning:** Only listed efforts are offered; OpenAI's catalog lacks
  reasoning data. Optional reasoning uses `reasoning_effort` for OpenAI/generic
  chat completions and `reasoning.effort` for OpenRouter and Codex Responses;
  Anthropic Messages sends `output_config.effort`; unless persisted
  `adaptiveThinking` is false it adds
  `thinking: {type: "adaptive", display: "summarized"}`. Lazy metadata refresh
  fills null fields independently, never replacing a known capability or output
  limit when learning the other. It sends neither for `none`, maps `minimal` to
  `low`. Adaptive-only models (Fable) ignore `enabled`; newer models default
  `display` to `omitted` — empty thinking text plus a signature while thinking
  tokens bill. Anthropic replay binds the alias, resolved response model,
  credential/format/endpoint provenance, and exact assistant artifact. Failed or
  unavailable identity leaves text-only Messages running but blocks both
  client-tool execution and provider-directed pause follow-up. Exact JSON-safe
  blocks, including additive fields, persist; corrupt metadata warns but leaves
  transcripts readable. Durable client-tool continuations require matching
  replay and result IDs; only the trailing tool-result turn fails closed when
  replay is missing, stale, incomplete, unsupported, or unsigned. Generic
  Anthropic identity prefers detail retrieval, then resolves an exact selected
  ID through the bounded paginated model list when detail retrieval is
  permanently unsupported or malformed; transient and authentication failures do
  not downgrade. Older incompatible tool history falls back to plain
  reconstruction. Trailing result IDs use deduplicated, order-insensitive sets.
  Transient retrieval failures retry later; permanent unresolved identities stay
  cached. Runtime conversation reads resolve the model before loading persisted
  replay; unresolved identity remains fail-closed rather than acting as a
  wildcard. Known resolved identities flow to agent, compactor, and attachment
  fallback. Empty text drops (whitespace stays), but content and replay are
  withheld together across every trailing text block; a pause fails if none
  remain replayable. `cache_control` marks only text/client `tool_use`, scanning
  backward; trailing replay is resent verbatim. `pause_turn` validates resent
  blocks, replays them/container without duplicate UI, sums usage, caps at five
  continuations, and fails terminal client tools closed when replay cannot
  combine. The local proxy tolerates unsigned tool-loop replay; strict endpoints
  may not. Streamed reasoning deltas group by `output_index`/`summary_index`;
  separate summary parts with paragraphs since completed responses may omit
  them.
- **Admission:** Frozen clocks can collapse admission transitions; production
  cannot. Fresh sockets admit non-retained `response.*`; reused ones require an
  ID or `response.created`. WebSocket Mode expires at 60 minutes; either
  spelling of `websocket_connection_limit_reached` replaces the socket once per
  step, then retries replay only the unpersisted step. HTTP waits are not
  admission-bounded. Discard mismatched-ID/retained-ID frames and errors. A
  reused socket's uncorrelated pre-admission error retries fresh unless
  permanent; after any admission (including ID-less), an unidentified error
  retires it and retries fresh. Provider IDs (~53 bytes) are unbounded: fence at
  16 MiB, then retire. ID-less admission skips retained IDs until a new one;
  completion retires it. Concurrency closes superseded sockets; fenced watchdog
  failures abort.
- **Retry:** An OpenAI OAuth API 401 forces one credential refresh and one
  replay of the unpersisted step after clearing partial output; concurrent
  refreshes coalesce because refresh tokens rotate. A second 401 stops. Native
  attachments share the session refresher; distinct fallback models bind the
  selected credential's refresher. Responses WebSocket recovery recognizes
  canonical nested `authentication_error` and `invalid_api_key` events as well
  as HTTP status failures. Requests unacknowledged through the 5-minute liveness
  grace fail without retry, resumable by `continue`. Other
  WebSocket/accepted-HTTP interruptions or provider errors retry before
  persistence; replays reset partial UI deltas; exhausted sockets use HTTP.
  Permanent errors/aborts never retry; terminal failures persist as nonreplayed
  `error`.
