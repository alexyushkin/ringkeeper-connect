// Drives Claude Code headless against the spike gateway and records what it did.
//   node spike/run-claude-code.mjs [scenario...] [--model haiku] [--repeat 2]
// Needs `pnpm build`, `pnpm spike start` and `pnpm spike configs` first.
// Uses --strict-mcp-config with throwaway config files, so the user's own
// Claude Code MCP setup is never read or changed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = join(root, "spike", ".data");
const outDir = join(root, "spike", "out");
const runDir = join(outDir, "cc-run");
fs.mkdirSync(runDir, { recursive: true });

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const model = opt("model", undefined);
const repeat = Number(opt("repeat", "1"));
// --fixed forces fixed mode (as Claude Desktop gets) so the wording can be tested headless.
const fixed = argv.includes("--fixed") && argv.splice(argv.indexOf("--fixed"), 1).length > 0;

const runtime = () => JSON.parse(fs.readFileSync(join(dataDir, "runtime.json"), "utf8"));
async function admin(path, body) {
  const { port, token } = runtime();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const scenarios = {
  // Switch with the meta tool, then use a tool only the new client has, in the same turn.
  switch_in_turn: {
    setup: { active: "acme", clientArg: false },
    turns: ["Using the ringkeeper tools: switch to the client Globex, then list Globex's Airtable bases and tell me their names."],
  },
  // The tray switches the client between two turns of one session.
  tray_switch_between_turns: {
    setup: { active: "acme", clientArg: false },
    turns: [
      "Using the ringkeeper tools, list the n8n workflows.",
      { before: { active: "globex" }, text: "List the n8n workflows again, and also the Airtable bases if there's a tool for that." },
    ],
  },
  // Client argument on, and the tray switches between turns while the model still thinks it's on Acme.
  tray_switch_client_arg: {
    setup: { active: "acme", clientArg: true },
    turns: [
      "Using the ringkeeper tools, list Acme's n8n workflows.",
      { before: { active: "globex" }, text: "Now get the details of Acme's lead intake workflow." },
    ],
  },
  // Client argument on: a plain request for the active client.
  client_arg_plain: {
    setup: { active: "acme", clientArg: true },
    turns: ["Using the ringkeeper tools, list the n8n workflows."],
  },
  // Client argument on: the user names a client that isn't active.
  client_arg_mismatch: {
    setup: { active: "acme", clientArg: true },
    turns: ["Using the ringkeeper tools, list Globex's n8n workflows."],
  },
};

function logLinesSince(offset) {
  const raw = fs.readFileSync(join(dataDir, "gateway.log"), "utf8");
  return raw
    .slice(offset)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => !["upstream_stderr", "http"].includes(e.ev));
}

async function runOnce(name, transport) {
  const sc = scenarios[name];
  await admin("/admin/active-client", { client: sc.setup.active });
  await admin("/admin/options", { requireClientArg: sc.setup.clientArg, dynamicHosts: fixed ? [] : ["claude-code", "cursor-vscode"] });
  const logOffset = fs.statSync(join(dataDir, "gateway.log")).size;

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", join(outDir, `claude-code-${transport}.json`),
    "--strict-mcp-config",
    "--allowedTools", "mcp__ringkeeper",
    "--setting-sources", "project",
    "--no-session-persistence",
  ];
  if (model) args.push("--model", model);

  const child = spawn("claude", args, { cwd: runDir, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  const record = { scenario: name, transport, mode: fixed ? "fixed" : "dynamic", model: model ?? "default", turns: [], toolsAtStart: [], events: [] };
  let buf = "";
  let onResult;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        record.toolsAtStart = (ev.tools ?? []).filter((t) => t.startsWith("mcp__"));
        record.mcpServers = ev.mcp_servers;
        record.actualModel = ev.model;
      }
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "tool_use") record.events.push({ call: c.name, input: c.input });
        }
      }
      if (ev.type === "user") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "tool_result") {
            const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" | ") : String(c.content);
            record.events.push({ result: text.slice(0, 300), isError: !!c.is_error });
          }
        }
      }
      if (ev.type === "result") onResult?.(ev);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  for (const turn of sc.turns) {
    const t = typeof turn === "string" ? { text: turn } : turn;
    if (t.before?.active) {
      await admin("/admin/active-client", { client: t.before.active });
      record.events.push({ tray_switch: t.before.active });
      await new Promise((r) => setTimeout(r, 1500));
    }
    const done = new Promise((r) => (onResult = r));
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: t.text } }) + "\n");
    const res = await Promise.race([done, new Promise((r) => setTimeout(() => r({ result: "TIMEOUT" }), 240_000))]);
    record.turns.push({ prompt: t.text, answer: String(res.result ?? "").slice(0, 600) });
  }
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  record.gateway = logLinesSince(logOffset).map(({ t, ...rest }) => rest);
  if (stderr.trim()) record.stderr = stderr.slice(0, 500);
  return record;
}

const transports = opt("transport", "http,bridge").split(",");
const names = argv.length ? argv : Object.keys(scenarios);
const results = [];
for (const name of names) {
  for (const transport of transports) {
    for (let r = 0; r < repeat; r++) {
      process.stderr.write(`running ${name} via ${transport} (${model ?? "default"}) #${r + 1}\n`);
      results.push(await runOnce(name, transport));
    }
  }
}
const file = join(outDir, `cc-results-${model ?? "default"}-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(file);
