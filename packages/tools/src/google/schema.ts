// Arguments: each tool's JSON Schema, checked here before Google is called (the MCP
// server passes arguments through as the AI sent them). Defaults come from the schema.
import { ToolError, type BuiltinTool } from "../types.js";
import type { AccessKey } from "./access.js";
import { Google } from "./http.js";

export type Schema = {
  type?: string | string[];
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  default?: unknown;
};

export const ID_PATTERN = "^[A-Za-z0-9_\\-]{6,200}$";
export const ADDRESS_PATTERN = '^[^@\\s<>"]+@[^@\\s<>"]+\\.[^@\\s<>"]+$';

/** Small builders, so a tool's arguments read like Ringkeeper's. */
export const s = {
  str: (o: Omit<Schema, "type"> = {}): Schema => ({ type: "string", ...o }),
  int: (o: Omit<Schema, "type"> = {}): Schema => ({ type: "integer", ...o }),
  bool: (o: Omit<Schema, "type"> = {}): Schema => ({ type: "boolean", ...o }),
  list: (items: Schema, o: Omit<Schema, "type" | "items"> = {}): Schema => ({ type: "array", items, ...o }),
  oneOf: (values: string[], o: Omit<Schema, "type" | "enum"> = {}): Schema => ({ type: "string", enum: values, ...o }),
  id: (description: string): Schema => ({ type: "string", description, pattern: ID_PATTERN }),
  address: (): Schema => ({ type: "string", pattern: ADDRESS_PATTERN }),
  limit: (fallback: number): Schema => ({ type: "integer", minimum: 1, maximum: 50, default: fallback }),
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function fits(type: string, value: unknown): boolean {
  const got = typeOf(value);
  return got === type || (type === "number" && got === "integer");
}

/** The value checked against its schema (defaults filled in), or a ToolError naming what's wrong. */
export function check(schema: Schema, value: unknown, where: string): unknown {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => fits(t, value))) throw new ToolError(`${where} should be ${types.join(" or ")}.`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolError(`${where} should be one of: ${schema.enum.join(", ")}.`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ToolError(schema.minLength === 1 ? `${where} can't be empty.` : `${where} is too short.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ToolError(`${where} is too long (at most ${schema.maxLength.toLocaleString("en-US")} characters).`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      throw new ToolError(`${where} isn't in the expected form.`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ToolError(`${where} should be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ToolError(`${where} should be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ToolError(schema.minItems === 1 ? `${where} can't be empty.` : `${where} needs at least ${schema.minItems} items.`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ToolError(`${where} has too many items (at most ${schema.maxItems}).`);
    const items = schema.items;
    return items ? value.map((v, i) => check(items, v, `${where}[${i}]`)) : value;
  }
  if (schema.properties && typeOf(value) === "object") {
    return object(schema, value as Record<string, unknown>, where);
  }
  return value;
}

export function object(schema: Schema, value: Record<string, unknown>, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [key, inner] of Object.entries(schema.properties ?? {})) {
    const name = where ? `${where}.${key}` : key;
    const given = value[key];
    if (given === undefined || given === null) {
      if (schema.required?.includes(key)) throw new ToolError(`${name} is needed.`);
      if (inner.default !== undefined) out[key] = inner.default;
      else delete out[key];
      continue;
    }
    out[key] = check(inner, given, name);
  }
  return out;
}

export type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  needs: AccessKey[];
  properties?: Record<string, Schema>;
  required?: string[];
  /** `g` calls Google with the connection's token; a refusal names this tool's access. */
  run(args: Args, g: Google): Promise<unknown>;
}

/** A BuiltinTool whose arguments are checked (and defaulted) before it runs. */
export function tool(def: ToolDef): BuiltinTool {
  const properties = def.properties ?? {};
  const schema: Schema = { type: "object", properties, required: def.required ?? [] };
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: "object", properties, ...(def.required?.length ? { required: def.required } : {}) },
    needs: def.needs,
    run: async (args, ctx) => def.run(object(schema, args ?? {}, ""), new Google(ctx, def.needs)),
  };
}

/** Typed readers for checked arguments. */
export const arg = {
  str: (a: Args, k: string): string => String(a[k] ?? ""),
  opt: (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined),
  int: (a: Args, k: string): number => Number(a[k]),
  bool: (a: Args, k: string): boolean => a[k] === true,
  strs: (a: Args, k: string): string[] | undefined => (Array.isArray(a[k]) ? (a[k] as string[]) : undefined),
};
