// Across a realistic multi-turn Claude Code session, is the forwarded cached
// prefix (every block up to the last cache_control marker) byte-stable turn to
// turn? Evidence for docs/fork/pxpipe-prompt-cache.md.
//
//   npm install --prefix /tmp/pxpipe-study pxpipe-proxy@0.13.2
//   node apps/server/src/sidecar/__fixtures__/pxpipe-cache-probe/prefix-probe.mjs
//
// Same mock upstream as transform-probe.mjs: no Anthropic calls, no API key.
// A probe against a third-party binary, not a test.
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const OUT = NodePath.join(NodeOS.tmpdir(), "pxpipe-cache-probe") + "/";
NodeFS.mkdirSync(OUT, { recursive: true });
const UPSTREAM_PORT = 47941;
const PROXY_PORT = 47942;

const captured = [];
const upstream = NodeHttp.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 12345 }));
    }
    captured.push({ headers: { ...req.headers }, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  });
});

const SYSTEM_STATIC =
  "You are Claude Code, Anthropic's official CLI for Claude.\n" +
  Array.from(
    { length: 500 },
    (_, i) => `Guideline ${i}: prefer editing an existing file to creating a new one.`,
  ).join("\n");

// Session-stable dynamic blocks (what real Claude Code sends: cwd, platform, date).
const ENV_BLOCK =
  "<env>\nWorking directory: /repo\nPlatform: darwin\nToday's date: 2026-09-19\n</env>";

function makeBody(turn, { billingHeader = true, totalTokens = false } = {}) {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Turn 1: explain the build." }] },
  ];
  for (let t = 2; t <= turn; t++) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `Answer ${t - 1}. ` + "detail ".repeat(400) }],
    });
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Turn ${t}: follow-up question number ${t}.` }],
    });
  }
  // Claude Code marks the last user block.
  const last = messages[messages.length - 1];
  last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
  const sys = [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    {
      type: "text",
      text:
        SYSTEM_STATIC +
        "\n" +
        ENV_BLOCK +
        (totalTokens ? `\n<total_tokens>${turn * 1000}</total_tokens>` : ""),
      cache_control: { type: "ephemeral" },
    },
  ];
  // Claude Code >= 2.1.222 sends the per-turn billing line as its OWN unmarked block.
  if (billingHeader)
    sys.push({
      type: "text",
      text: `x-anthropic-billing-header: cch=07295,cc_prev_req=req_${turn}`,
    });
  return {
    model: "claude-fable-5",
    max_tokens: 4096,
    stream: false,
    metadata: { user_id: "user_abc_session_1" },
    system: sys,
    tools: [
      {
        name: "Bash",
        description: "Run a shell command. " + "Tool documentation. ".repeat(300),
        input_schema: {
          type: "object",
          properties: { command: { type: "string", description: "cmd" } },
          required: ["command"],
        },
      },
      {
        name: "Read",
        description: "Read a file. " + "Tool documentation. ".repeat(300),
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string", description: "path" } },
          required: ["file_path"],
        },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
  };
}

async function post(body) {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-fake",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
    },
    body: JSON.stringify(body),
  });
  await r.text();
}

/** Everything up to and including the block carrying the LAST cache_control marker. */
function cachedPrefix(raw) {
  const b = JSON.parse(raw.toString());
  const flat = [];
  const add = (label, arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((blk, i) => {
      if (label === "messages" && blk && Array.isArray(blk.content)) {
        blk.content.forEach((c, j) =>
          flat.push([
            `messages[${i}].content[${j}]`,
            JSON.stringify(c),
            c?.cache_control !== undefined,
          ]),
        );
      } else flat.push([`${label}[${i}]`, JSON.stringify(blk), blk?.cache_control !== undefined]);
    });
  };
  add("tools", b.tools);
  add("system", b.system);
  add("messages", b.messages);
  let last = -1;
  flat.forEach((e, i) => {
    if (e[2]) last = i;
  });
  return flat.slice(0, last + 1);
}
const sha = (s) => NodeCrypto.createHash("sha256").update(s).digest("hex").slice(0, 10);

async function run(label, env, opts) {
  captured.length = 0;
  const proc = NodeChildProcess.spawn(
    process.execPath,
    ["/tmp/pxpipe-study/node_modules/pxpipe-proxy/bin/cli.js"],
    {
      env: {
        ...process.env,
        PORT: String(PROXY_PORT),
        ANTHROPIC_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
        PXPIPE_LOG: `${OUT}/ev-${label}.jsonl`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout.resume();
  proc.stderr.resume();
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PROXY_PORT}/proxy-stats`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const inputs = [];
  for (const turn of [1, 2, 3, 4]) {
    const b = makeBody(turn, opts);
    inputs.push(b);
    await post(b);
  }
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n######## ${label}  env=${JSON.stringify(env)} opts=${JSON.stringify(opts)}`);
  // Baseline: what the client itself would have sent (no proxy).
  console.log(
    "  UNPROXIED client prefix hashes:",
    inputs
      .map((b) =>
        sha(
          cachedPrefix(Buffer.from(JSON.stringify(b)))
            .map((e) => e[1])
            .join("|"),
        ),
      )
      .join(" "),
  );
  const prefixes = captured.map((c) => cachedPrefix(c.body));
  console.log(
    "  FORWARDED prefix hashes:      ",
    prefixes.map((p) => sha(p.map((e) => e[1]).join("|"))).join(" "),
  );
  // Longest common byte-prefix across consecutive turns, block by block.
  for (let i = 1; i < prefixes.length; i++) {
    const a = prefixes[i - 1],
      b = prefixes[i];
    let common = 0;
    while (
      common < Math.min(a.length, b.length) &&
      a[common][0] === b[common][0] &&
      a[common][1] === b[common][1]
    )
      common++;
    const bytesCommon = a.slice(0, common).reduce((n, e) => n + e[1].length, 0);
    const bytesTotal = b.reduce((n, e) => n + e[1].length, 0);
    console.log(
      `  turn${i} -> turn${i + 1}: ${common}/${b.length} prefix blocks identical (${bytesCommon}/${bytesTotal} bytes)` +
        (common < b.length ? `  first divergence @ ${b[common]?.[0]}` : "  FULL PREFIX STABLE"),
    );
  }
  console.log(
    "  billing header forwarded as HTTP header:",
    captured.map((c) => c.headers["x-anthropic-billing-header"] ?? "-").join(" | "),
  );
}

await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
await run(
  "E-imaged-stable-system",
  { PXPIPE_MODELS: "claude-fable-5" },
  { billingHeader: true, totalTokens: false },
);
await run(
  "F-imaged-total-tokens",
  { PXPIPE_MODELS: "claude-fable-5" },
  { billingHeader: true, totalTokens: true },
);
await run("G-passthrough", { PXPIPE_MODELS: "off" }, { billingHeader: true, totalTokens: false });
upstream.close();
process.exit(0);
