// Summarise spike/out/cc-results-*.json into one line per run.
import fs from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(import.meta.dirname, "out");
const files = fs.readdirSync(outDir).filter((f) => f.startsWith("cc-results-") && f.endsWith(".json"));
const rows = [];
for (const f of files) {
  for (const r of JSON.parse(fs.readFileSync(join(outDir, f), "utf8"))) {
    const g = r.gateway ?? [];
    const firstNotice = g.findIndex((e) => e.ev?.startsWith("send_list_changed") || e.ev === "list_changed_pending");
    const refetched = firstNotice >= 0 && g.slice(firstNotice).some((e) => e.ev === "rpc_in" && e.method === "tools/list");
    const calls = (r.events ?? []).filter((e) => e.call && e.call !== "ToolSearch").map((e) => {
      const name = e.call.replace("mcp__ringkeeper__", "");
      const claimed = e.input?.ringkeeper_client;
      return claimed === undefined ? name : `${name}(${claimed})`;
    });
    const refusals = g.filter((e) => e.ev?.startsWith("refused_")).map((e) => e.ev.replace("refused_", ""));
    const proxied = g.filter((e) => e.ev === "call_proxied").map((e) => `${e.tool}@${e.client}`);
    rows.push({
      scenario: r.scenario,
      via: r.transport,
      mode: r.mode ?? "dynamic",
      model: r.actualModel ?? r.model,
      notice: firstNotice >= 0 ? g[firstNotice].ev.replace("send_list_changed", "sent").replace("list_changed_pending", "held") : "-",
      refetched,
      calls: calls.join(" → "),
      ran: proxied.join(", ") || "-",
      refused: refusals.join(", ") || "-",
      answer: (r.turns?.at(-1)?.answer ?? "").replace(/\s+/g, " ").slice(0, 140),
    });
  }
}
rows.sort((a, b) => (a.scenario + a.via + a.model).localeCompare(b.scenario + b.via + b.model));
for (const r of rows) console.log(JSON.stringify(r));
