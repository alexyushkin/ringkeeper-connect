// Some tools name their inputs with characters AI apps refuse. Twilio, for
// example, has filters called "DateSent<" and "StartTime>"; Claude only accepts
// input names made of letters, digits, "_", "." and "-" (up to 64), and drops the
// whole tool otherwise. So the gateway shows such inputs under valid names
// ("DateSent_before", "StartTime_after") and renames them back before passing a
// call on.

/** What AI apps accept as an input name. */
const VALID_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Per shown name: the tool's own name, and the same for inputs nested inside it. */
export interface NameMap {
  [shown: string]: { original: string; inner?: NameMap; items?: NameMap };
}

type Schema = Record<string, unknown>;

function validName(original: string, taken: Set<string>): string {
  let base = original
    .replace(/>=?/g, "_after")
    .replace(/<=?/g, "_before")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 60);
  if (!base) base = "input";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** A schema's object inputs, renamed where needed. Returns the new schema and the renames (undefined if none). */
function renameObject(schema: Schema): { schema: Schema; map?: NameMap } {
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return renameItems(schema);
  const entries = Object.entries(props as Record<string, unknown>);
  const taken = new Set(entries.map(([k]) => k).filter((k) => VALID_NAME.test(k)));
  const map: NameMap = {};
  let changed = false;
  const newProps: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const shown = VALID_NAME.test(key) ? key : validName(key, taken);
    taken.add(shown);
    const inner = value && typeof value === "object" && !Array.isArray(value) ? renameObject(value as Schema) : { schema: value as Schema };
    newProps[shown] = inner.schema;
    if (shown !== key || inner.map) {
      changed = true;
      map[shown] = { original: key, ...(inner.map ? (isItems(value) ? { items: inner.map } : { inner: inner.map }) : {}) };
    } else {
      map[shown] = { original: key };
    }
  }
  if (!changed) return { schema };
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).map((r) => Object.entries(map).find(([, m]) => m.original === r)?.[0] ?? r)
    : schema.required;
  return { schema: { ...schema, properties: newProps, ...(required !== undefined ? { required } : {}) }, map };
}

function isItems(schema: unknown): boolean {
  return !!schema && typeof schema === "object" && "items" in (schema as Schema) && !("properties" in (schema as Schema));
}

/** Arrays of objects: rename inside each item. */
function renameItems(schema: Schema): { schema: Schema; map?: NameMap } {
  const items = schema.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return { schema };
  const inner = renameObject(items as Schema);
  return inner.map ? { schema: { ...schema, items: inner.schema }, map: inner.map } : { schema };
}

/** The input schema AI apps can accept, and how to rename a call's arguments back (undefined when nothing changed). */
export function safeInputSchema<T extends Schema>(schema: T): { schema: T; map?: NameMap } {
  const r = renameObject(schema);
  return { schema: r.schema as T, map: r.map };
}

/** A call's arguments with the tool's own input names again. */
export function originalArguments(args: unknown, map: NameMap | undefined): unknown {
  if (!map || !args || typeof args !== "object") return args;
  if (Array.isArray(args)) return args.map((a) => originalArguments(a, map));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const m = map[key];
    if (!m) {
      out[key] = value;
      continue;
    }
    const nested = m.inner ?? m.items;
    out[m.original] = nested ? originalArguments(value, nested) : value;
  }
  return out;
}
