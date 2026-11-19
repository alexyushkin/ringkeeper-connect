// The built-in services, by id (the catalog's "builtin" options name them).
import type { BuiltinService } from "./types.js";
import { google } from "./google.js";

export const SERVICES: Record<string, BuiltinService> = {
  google,
};

export { allowedTools, createToolServer } from "./server.js";
export { ToolError, type BuiltinService, type BuiltinTool, type ToolContext } from "./types.js";
