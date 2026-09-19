# pxpipe and Claude prompt caching

What `pxpipe-proxy@0.13.2` does to an Anthropic Messages request, whether it
does the same thing twice, and what that costs a routed instance in prompt
cache hits.

Measured against the pinned version the fork ships
(`PINNED_PXPIPE_VERSION` in `apps/server/src/sidecar/pxpipeVersionCache.ts`),
with a mock upstream. No Anthropic API calls, no API keys.

## Short answer

The old warning in `docs/user/pxpipe-sidecar.md` was wrong twice over.

1. With T3 Code's default settings, a routed Claude instance running Opus or
   Sonnet is forwarded **byte for byte**. pxpipe's built-in imaging scope is
   `claude-fable-5, gemini-3.6-flash, gemini-3.7-flash`, and T3's **Imaging
   models** field defaults to empty, which keeps that scope. Every other model
   takes the `compress=false` path, which returns the caller's original bytes
   without so much as a JSON round trip. Cache behaviour is identical to not
   running the proxy.
2. When imaging is on for the model in the request, pxpipe rewrites the body
   heavily, but the rewrite is **deterministic** and the whole design is built
   around keeping the cached prefix byte-stable. It moves `cache_control`
   markers rather than dropping them, and it removes a per-turn line that
   Claude Code itself puts inside the cached span. Cross-turn cache reads
   survive.

The real costs are narrower: switching an instance between routed and unrouted
pays one cache write, and per-turn churn in Claude Code's own dynamic system
blocks still lands inside the cached prefix on the imaged path.

## What the transform actually does

`dist/core/transform.js:transformRequest` is the whole Anthropic path. The
gate is in `dist/core/proxy.js` around line 1453: `isPxpipeSupportedModel(model)`
decides whether `transformOpts` or `{...transformOpts, compress: false}` goes
in.

### Not in the allowlist: byte-identical passthrough

```js
if (!o.compress) {
  info.reason = "compress=false";
  return { body, info };
}
```

`body` is the untouched request `Uint8Array`. It is not parsed, so it is not
re-serialized, so key order, whitespace and number formatting all survive
exactly. Measured: input 71,318 bytes in, 71,318 bytes out, `Buffer.equals`
true, for both `PXPIPE_MODELS=off` and the default scope with
`claude-opus-5-20260101`.

### In the allowlist: the rewrite

| Field           | What happens                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`        | Split three ways. The `x-anthropic-billing-header:` line is cut out of the body entirely. `# Environment`, `<env>`, `<context>`, `<git_status>`, `<directoryStructure>`, `<system-reminder>` and `<total_tokens>` stay as plain text in `req.system`, in place. Everything else (the big instruction slab) is rendered to PNG.                                       |
| `tools`         | Each client-defined tool keeps its `name` and a structure-only `input_schema`; `description` is replaced with a nine-word stub pointing at a heading inside the image, and schema annotations (`description`, `title`, `default`, `examples`) are stripped. Server-side tools with a versioned `type`, and tools with `defer_loading: true`, pass through untouched. |
| `messages`      | Image blocks for the system slab are prepended to the first user message, followed by an optional factsheet block and a literal `[End of rendered context.]` text block. Older turns behind the live tail may be collapsed into further image pages. Recent turns stay text.                                                                                         |
| `metadata`      | Never read, never written. Survives the JSON round trip.                                                                                                                                                                                                                                                                                                             |
| `stream`        | Never read. Responses stream through normally; pxpipe only rewrites requests.                                                                                                                                                                                                                                                                                        |
| `cache_control` | Preserved and relocated, see below.                                                                                                                                                                                                                                                                                                                                  |

The tool stub, verbatim from the forwarded body:

```json
{
  "name": "Bash",
  "description": "ⓘ Full docs: see \"## Tool: Bash\" in the Tool Reference section.",
  "input_schema": {
    "type": "object",
    "properties": { "command": { "type": "string" }, "timeout": { "type": "number" } },
    "required": ["command"]
  }
}
```

The input had a 5,021-character description and per-property descriptions. Both
ride inside the PNG instead.

### `cache_control`

pxpipe never invents a marker. `makeImageBlock` has the comment and the code to
match: "pxpipe never adds its own cache_control — only moves existing caller
markers across the text→image flip."

The marker that sat on the static system block moves onto the **last** rendered
image, so the breakpoint keeps its position relative to the content it covers.
One thing is modified on the way: `demoteRelocatedCacheControl` drops a
`scope` key if present, because a relocated marker is no longer a guaranteed
global prefix and `scope: "global"` would 400 the whole request. `type` and
`ttl` are preserved untouched, and a marker with no `scope` passes through as
identity.

Markers on `tools` and on the live message tail are left exactly where the
client put them. Measured, forwarded body with imaging on:

```
$.tools[1].cache_control = {"type":"ephemeral"}
$.messages[0].content[1]: IMAGE png b64 len=18408 cache_control={"type":"ephemeral"}
$.messages[2].content[1].cache_control = {"type":"ephemeral"}
```

Input marker count three, output marker count three.

### Headers

`STRIP_REQ_HEADERS` is the complete list of what does not reach the upstream:
`host`, `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`,
`upgrade`, `content-length`, `expect`, `accept-encoding`, `x-pxpipe-bypass`.

So `anthropic-beta`, `anthropic-version`, `x-api-key` and `authorization` all
pass through unmodified on the Anthropic route. Measured, with imaging on:

```
anthropic-beta:    extended-cache-ttl-2025-04-11,prompt-caching-2024-07-31
anthropic-version: 2023-06-01
x-api-key:         (forwarded verbatim)
```

The extended cache TTL beta header reaches Anthropic intact. pxpipe does not
parse or filter beta flags.

pxpipe **adds** one header on the imaged path: `x-anthropic-billing-header`,
carrying the line it excised from the system prompt. Where it went and why is
documented in `transform.js` near line 1930: putting the line back anywhere in
the body left it inside the span covered by the last marker, and telemetry
showed zero cache reads with 509 distinct prefix hashes per day. Moving it to a
real HTTP header takes it out of the cached bytes.

`x-pxpipe-bypass: 1` on a request turns off body transformation for that request
only. Routing and auth still apply, and the header itself is stripped before
forwarding. Claude Code can set it through `ANTHROPIC_CUSTOM_HEADERS`.

### Determinism

Yes, and it holds across process restarts.

| Config                         | Model                    | Same input twice, forwarded bytes equal |
| ------------------------------ | ------------------------ | --------------------------------------- |
| `PXPIPE_MODELS=claude-fable-5` | `claude-fable-5`         | yes                                     |
| default scope                  | `claude-opus-5-20260101` | yes (passthrough)                       |
| `PXPIPE_MODELS=off`            | `claude-fable-5`         | yes (passthrough)                       |
| `PXPIPE_MODELS=claude-opus-5`  | `claude-opus-5-20260101` | yes                                     |

The two rendered PNGs from the `claude-fable-5` run and from the
`claude-opus-5` run (separate processes, different `PXPIPE_MODELS` values,
identical input text) are byte-identical base64. The transform path contains no
`Date.now`, no `Math.random`, no UUID and no timestamp; the only `Date.now`
calls in the package are in `pin.js`, and they build synthetic **responses** to
`/pxpipe pin` commands, not forwarded request bodies.

One caveat that cannot be checked from outside: whether Anthropic keys its cache
on raw request bytes or on a normalized structure, and therefore whether JSON
key order matters. It does not matter here either way. On the passthrough path
the bytes are the caller's own. On the imaged path `JSON.parse` followed by
`JSON.stringify` preserves string-key insertion order in JavaScript, and the
forwarded bytes are reproducible, so key order is stable turn to turn whatever
the server does with it.

## Does the cache survive?

### (a) Within the routed path, across turns

Yes. Four-turn session, realistic Claude Code shape (static instruction slab
with a marker, a session-stable `<env>` block, a separate unmarked per-turn
billing-header block, two tools with a marker on the last, a marker on the final
user block). Comparing the forwarded cached prefix, meaning every block up to
and including the one carrying the last marker:

```
imaged (PXPIPE_MODELS=claude-fable-5)
  turn1 -> turn2:  7/10 prefix blocks identical (56343/59327 bytes)  diverges at messages[0].content[3]
  turn2 -> turn3:  9/12 prefix blocks identical (59229/62223 bytes)  diverges at messages[2].content[0]
  turn3 -> turn4: 11/14 prefix blocks identical (62125/65119 bytes)  diverges at messages[4].content[0]

passthrough (PXPIPE_MODELS=off), identical to what the client sent
  turn1 -> turn2:  4/8  prefix blocks identical (48054/51118 bytes)  diverges at system[2]
  turn2 -> turn3:  4/10 prefix blocks identical (48054/54014 bytes)  diverges at system[2]
  turn3 -> turn4:  4/12 prefix blocks identical (48054/56910 bytes)  diverges at system[2]
```

Read the divergence point, not the ratio. On the imaged path the first
difference is the conversation growing, which is what a cached prefix is
supposed to do. Tools, system and the slab images are all byte-stable.

On the passthrough path the first difference is `system[2]`, the client's own
per-turn billing-header block, sitting at byte 48,054. pxpipe deletes that block
from the body and sends it as a header, so on the imaged path the stable prefix
runs 8,289 bytes further than the client's own request does.

pxpipe is not merely cache-neutral here. On the billing-header axis it is
cache-better than unproxied Claude Code.

### The one case that does bust it

Per-turn churn inside a dynamic system block that pxpipe keeps as text. Same
session with a `<total_tokens>` counter that ticks every turn:

```
imaged, with a per-turn <total_tokens> in the system prompt
  turn1 -> turn2: 3/10 prefix blocks identical (515/59364 bytes)  diverges at system[1]
```

515 bytes of 59,364. The whole prefix is a cache write, every turn.

This is a deliberate trade, documented in `transform.js` near line 1915:
relocating the volatile env text into the message stream fixed the cache and
surfaced a `<system-reminder>` in the conversation as if the user had typed it,
so pxpipe stopped moving it. "Churn on these bytes costs prefix cache reads;
that is accepted."

It is not a pxpipe regression. An unrouted client with the same counter inside
its marked system block busts its own `system[1]` breakpoint the same way. But
the routed path cannot recover the way an unrouted one can, because the imaged
path pulls the breakpoint forward into `messages[0]`, so all the dynamic system
text sits inside the cached span rather than after it.

### (b) Between routed and unrouted instances

They never share a cache entry, and there is no fix for that. The imaged body
has different tools, a different system array and PNG blocks the unrouted body
does not have. Flipping **Route through pxpipe** on an instance costs exactly
one cache write on the next turn, then the new shape caches normally. Running
one routed and one unrouted instance side by side, as the user guide suggests,
means two cache entries, not a fight over one.

## Fix options, ranked

**1. Do nothing. Correct the documentation.** Shipped with this report. For the
default fork configuration there is nothing to fix: the body is forwarded
byte for byte, and the warning was describing a cost that is not being paid.
When imaging is on, the cache survives across turns.

**2. `PXPIPE_MODELS`, which T3 already exposes.** `pxpipeSpawnEnvironment` in
`apps/server/src/sidecar/PxpipeSidecar.ts` maps the **Imaging models** setting
straight onto `PXPIPE_MODELS`. `["off"]` turns imaging off for every model and
makes the proxy a byte-identical pipe that still reports stats. A model left out
of the list is passed through. The setting a user needs already exists, is
already documented, and needs no code.

**3. `x-pxpipe-bypass`, per request.** A T3-side setting could push
`ANTHROPIC_CUSTOM_HEADERS=x-pxpipe-bypass: 1` onto a routed instance. Not worth
building. It is strictly weaker than option 2, since an instance that wants
every request bypassed should not be routed at all, and it adds a settings field
for something the existing field already covers.

**4. Patching or forking pxpipe.** The only change worth naming: in
`transform.js`, the `sysTail` assembly around line 1928 re-emits `dynamicText`
and `envMarkdown` into `req.system`, which is inside the span covered by the
relocated marker. A patch would move those blocks after the last marker in the
message stream instead. pxpipe already tried exactly that and reverted it,
because the relocated `<system-reminder>` text showed up in the conversation as
user-authored. A correct version would need to relocate only the non-reminder
dynamic text and leave `<system-reminder>` in place. **Not implemented**, per
the task's instruction not to patch pxpipe. It is upstream's call, and the
`<total_tokens>` case it fixes may not exist in the Claude Code versions the
fork's users run.

**5. `pxpipe warp`.** Not a cache fix. `warp` runs the same transform; it only
changes how traffic is intercepted. It starts a loopback MITM forward proxy with
a self-generated CA (`pxpipe warp local CA`), spawns the child with
`HTTP_PROXY`/`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/
`CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE` pointed at that CA, and deletes
`ANTHROPIC_BASE_URL` and `ANTHROPIC_UNIX_SOCKET` from the child environment. The
agent still believes it is talking to `api.anthropic.com`, so `/remote-control`
and claude.ai connectors keep working. That is the feature ADR 0004 named, and
its cost is still what ADR 0004 says: a command builder at every spawn site
instead of one environment rule, plus a local CA installed into every routed
child.

## `/proxy-stats`

The health probe endpoint in `PxpipeSidecar.ts`. It returns a flat JSON object
of counters over an in-memory ring:

`requests`, `compressed_requests`, `compression_enabled`, `saved_pct`,
`saved_pct_input_only`, `saved_pct_of_total_bill`, `saved_pct_of_all_spend`,
`saved_input_tokens`, `saved_usd`, `baseline_input_weighted`,
`actual_input_weighted`, `output_weighted`, `compressed_actual_usd`,
`passthrough_actual_usd`, `compressed_avg_usd_per_request`,
`passthrough_avg_usd_per_request`, `compressed_minus_passthrough_avg_usd`,
`events_with_measurement`, `measured_text_chars`, `measured_thinking_chars`,
`measured_tool_use_chars`, `measured_redacted_block_count`, `render_cache`,
`pricing_assumptions`, `split_sufficient_sample`,
`split_min_sample_per_bucket`, `uptime_sec`.

No prompt text, no headers, no model output. Counters and money estimates only.
T3 decodes it as an open `Record<string, unknown>`, so new keys in a future
pinned version will not break the probe.

## Reproducing this

Two scripts, both under
`apps/server/src/sidecar/__fixtures__/pxpipe-cache-probe/`. They spawn the
pinned pxpipe against a mock upstream that records raw request bytes and returns
a canned Messages response. Nothing reaches Anthropic and no key is needed.

```bash
npm install --prefix /tmp/pxpipe-study pxpipe-proxy@0.13.2
node apps/server/src/sidecar/__fixtures__/pxpipe-cache-probe/transform-probe.mjs
node apps/server/src/sidecar/__fixtures__/pxpipe-cache-probe/prefix-probe.mjs
```

They are probes against a third-party binary, not tests. They need a network
install and about a minute of PNG encoding, so they are not wired into
`vp test run`.
