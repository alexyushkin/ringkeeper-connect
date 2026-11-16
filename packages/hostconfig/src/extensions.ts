// Claude Desktop Extensions are installed from inside Claude Desktop and
// don't appear in its config file. We can't move them, but we can spot ones
// that overlap with a client's connections and warn about them.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { detectService, type Service } from "./import.js";

export interface DesktopExtension {
  id: string;
  name: string;
  service?: Service;
}

/** Extensions installed next to Claude Desktop's config file. */
export function listDesktopExtensions(desktopConfigPath: string): DesktopExtension[] {
  const dir = join(dirname(desktopConfigPath), "Claude Extensions");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: DesktopExtension[] = [];
  for (const id of entries) {
    if (/\.backup-\d+$/.test(id)) continue; // old copies Claude Desktop keeps after updates
    let manifest: { name?: string; display_name?: string } = {};
    try {
      manifest = JSON.parse(fs.readFileSync(join(dir, id, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const name = manifest.display_name || manifest.name || id;
    out.push({ id, name, service: detectService(`${id} ${name}`, {}) });
  }
  return out;
}
