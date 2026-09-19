// What pxpipe does to a Claude Code-shaped /v1/messages body, and whether it
// does the same thing twice. Evidence for docs/fork/pxpipe-prompt-cache.md.
//
//   npm install --prefix /tmp/pxpipe-study pxpipe-proxy@0.13.2
//   node apps/server/src/sidecar/__fixtures__/pxpipe-cache-probe/transform-probe.mjs
//
// Spawns the pinned pxpipe against a mock upstream that records raw request
// bytes. Nothing reaches Anthropic and no API key is involved. This is a probe
// against a third-party binary, not a test, so it is not in `vp test run`.
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const OUT = NodePath.join(NodeOS.tmpdir(), "pxpipe-cache-probe") + "/";
NodeFS.mkdirSync(OUT, { recursive: true });

const UPSTREAM_PORT = 47931;
const PROXY_PORT = 47932;

const captured = [];
const upstream = NodeHttp.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url.includes("count_tokens")) {
      // count_tokens probe: answer it, do not record it as a forward.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 12345 }));
      return;
    }
    captured.push({ url: req.url, headers: { ...req.headers }, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
  });
});

// A Claude Code-shaped request: system array with cache_control, tools with
// cache_control, multi-turn messages, plus the per-turn billing header line.
function makeBody(model, turn) {
  const bigInstructions =
    "You are Claude Code, Anthropic's official CLI for Claude.\n" +
    Array.from(
      { length: 400 },
      (_, i) => `Instruction line ${i}: do the thing carefully and cite files by absolute path.`,
    ).join("\n");
  return {
    model,
    max_tokens: 4096,
    stream: false,
    metadata: { user_id: "user_abc123_account_xyz_session_0001" },
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: "text",
        text:
          bigInstructions +
          `\nx-anthropic-billing-header: cch=07295,cc_prev_req=req_${turn}\n` +
          "# Environment\nWorking directory: /repo\nCurrent branch: main\nGit status: clean\n" +
          `\n<env>\nToday: 2026-09-19\n</env>\n<total_tokens>${turn * 1000}</total_tokens>`,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: "Bash",
        description: "Run a shell command. " + "Long tool documentation. ".repeat(200),
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run" },
            timeout: { type: "number", description: "Timeout in ms" },
          },
          required: ["command"],
        },
      },
      {
        name: "Read",
        description: "Read a file. " + "More documentation text here. ".repeat(200),
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string", description: "Absolute path" } },
          required: ["file_path"],
        },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "First question about the repo." }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer. " + "detail ".repeat(500) }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Second question." },
          { type: "text", text: "context ".repeat(3000), cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  };
}

async function post(body) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-fake-not-a-real-key",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "extended-cache-ttl-2025-04-11,prompt-caching-2024-07-31",
      "user-agent": "claude-cli/2.1.222 (external, cli)",
    },
    body: JSON.stringify(body),
  });
  await res.text();
}

function summarize(raw) {
  const b = JSON.parse(raw.toString());
  const walk = (v, path, acc) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, acc));
    else if (v && typeof v === "object") {
      if (v.type === "image" && v.source?.data) {
        acc.push(
          `${path}: IMAGE png b64 len=${v.source.data.length}${v.cache_control ? ` cache_control=${JSON.stringify(v.cache_control)}` : ""}`,
        );
        return;
      }
      if (v.cache_control !== undefined)
        acc.push(`${path}.cache_control = ${JSON.stringify(v.cache_control)}`);
      for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`, acc);
    } else if (typeof v === "string" && v.length > 120) {
      acc.push(`${path}: <string ${v.length} chars> "${v.slice(0, 80).replace(/\n/g, "\\n")}…"`);
    }
    return acc;
  };
  return { keys: Object.keys(b), notes: walk(b, "$", []) };
}

async function run(label, env, model) {
  captured.length = 0;
  const proc = NodeChildProcess.spawn(
    process.execPath,
    ["/tmp/pxpipe-study/node_modules/pxpipe-proxy/bin/cli.js"],
    {
      env: {
        ...process.env,
        PORT: String(PROXY_PORT),
        ANTHROPIC_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
        PXPIPE_LOG: `${OUT}/events-${label}.jsonl`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  // wait for the port
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/proxy-stats`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const body = makeBody(model, 7);
  await post(body); // run 1
  await post(body); // run 2, identical input
  const bodyNext = makeBody(model, 8); // same session, next turn (billing header + total_tokens churn)
  await post(bodyNext);

  const stats = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/proxy-stats`)).json();
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));

  const inBytes = Buffer.from(JSON.stringify(body));
  const r1 = captured[0]?.body,
    r2 = captured[1]?.body,
    r3 = captured[2]?.body;
  const report = {
    label,
    model,
    env,
    forwardedCount: captured.length,
    inputBytes: inBytes.length,
    forwardedBytes: r1?.length,
    identicalInput_run1_vs_run2: r1 && r2 ? r1.equals(r2) : null,
    passthroughByteIdentical: r1 ? r1.equals(inBytes) : null,
    turn7_vs_turn8_identical: r1 && r3 ? r1.equals(r3) : null,
    headersForwarded: captured[0] ? Object.keys(captured[0].headers).sort() : [],
    anthropicBetaForwarded: captured[0]?.headers["anthropic-beta"],
    anthropicVersionForwarded: captured[0]?.headers["anthropic-version"],
    apiKeyForwarded: captured[0]?.headers["x-api-key"],
    forwardedShape: r1 ? summarize(r1) : null,
    proxyStatsKeys: Object.keys(stats).sort(),
  };
  NodeFS.writeFileSync(`${OUT}/${label}.json`, JSON.stringify(report, null, 2));
  if (r1) NodeFS.writeFileSync(`${OUT}/${label}-forwarded-1.json`, r1);
  if (r3) NodeFS.writeFileSync(`${OUT}/${label}-forwarded-3.json`, r3);
  NodeFS.writeFileSync(`${OUT}/${label}-input.json`, inBytes);
  NodeFS.writeFileSync(`${OUT}/${label}-proxy.log`, log);
  NodeFS.writeFileSync(`${OUT}/${label}-stats.json`, JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

// A: imaging ON for the model actually in the request
await run("imaged-fable", { PXPIPE_MODELS: "claude-fable-5" }, "claude-fable-5");
// B: default PXPIPE_MODELS, model = opus 5 (not in default allowlist)
await run("default-opus5", {}, "claude-opus-5-20260101");
// C: PXPIPE_MODELS=off
await run("models-off", { PXPIPE_MODELS: "off" }, "claude-fable-5");
// D: imaging on for opus5 (explicit opt-in)
await run("imaged-opus5", { PXPIPE_MODELS: "claude-opus-5" }, "claude-opus-5-20260101");

upstream.close();
process.exit(0);
