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

/**
 * Extensions installed in Claude Desktop: next to its config file, and in the
 * classic and Store folders (newer builds keep extensions there even when the
 * config file lives in Claude-Data; unverified, so all are looked at).
 */
export function listDesktopExtensions(desktopConfigPath: string, moreFolders: string[] = []): DesktopExtension[] {
  const out: DesktopExtension[] = [];
  const seen = new Set<string>();
  for (const folder of [dirname(desktopConfigPath), ...moreFolders]) {
    for (const e of extensionsIn(join(folder, "Claude Extensions"))) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

function extensionsIn(dir: string): DesktopExtension[] {
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
