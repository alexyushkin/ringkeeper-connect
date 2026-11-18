// The contract between the window and the main process. Secret values only
// ever travel window → main (when the user types a key), never back.
import type { ClientView, ConnectionInput, ConnectionView, Settings } from "@ringkeeper/gateway/store";
import type { ConnectionStatus } from "@ringkeeper/gateway";
import type { CatalogService } from "@ringkeeper/catalog";

export type { CatalogService };

export type { ClientView, ConnectionInput, ConnectionView, Settings, ConnectionStatus };

export type HostId = "claude-desktop" | "cursor" | "claude-code" | "vscode" | "kiro" | "antigravity" | "codex";

/**
 * Whether an AI app really uses Ringkeeper:
 * - connected: its bridge has contacted us since our entry was written
 * - added: entry written; restart the app to finish
 * - not_seeing: the app restarted since, and still no contact
 * - missing: the app removed our entry (Fix puts it back)
 * - not_connected / unreadable / not_installed
 */
export type AppStatus = "not_installed" | "unreadable" | "not_connected" | "missing" | "added" | "connected" | "not_seeing";

export interface HostView {
  id: HostId;
  label: string;
  status: AppStatus;
  problem?: string;
  /** Which settings file is used, when there was a choice. */
  note?: string;
  configPath: string;
  otherConnections: string[];
  lastContactAt?: number;
  /** Plain steps to check it's working. */
  howToCheck: string[];
  /** Added after the first release: not ticked in the wizard unless picked. */
  optIn: boolean;
  /** The app finds Ringkeeper through this other app's settings (so it has no entry of its own). */
  viaLabel?: string;
}

/** A connection found in an AI app that the user hasn't decided about yet. */
export interface FoundConnection {
  host: HostId;
  hostLabel: string;
  name: string;
}

export interface AppState {
  clients: ClientView[];
  statuses: ConnectionStatus[];
  settings: Settings;
  hosts: HostView[];
  found: FoundConnection[];
  /** The first-run setup has been completed or skipped. */
  setupDone: boolean;
  version: string;
  /** A downloaded update waiting for a restart. */
  updateReady?: string;
  /** Installed build (not a development run). */
  packaged: boolean;
}

/** What the setup wizard can bring in (no key values). */
export interface ImportCandidateView {
  key: string;
  name: string;
  from: string[];
  service?: string;
  /** Why it can't be brought in. */
  problem?: string;
  warnings: string[];
}

/** An app Ringkeeper only reads connections from. */
export interface SourceView {
  label: string;
  count: number;
  /** Files that couldn't be read, each with a plain reason. */
  problems: string[];
}

/** A Claude Desktop extension, and the catalog tool for the same service if there is one. */
export interface ExtensionView {
  name: string;
  toolId?: string;
  toolName?: string;
}

export interface ImportScan {
  hosts: HostView[];
  candidates: ImportCandidateView[];
  /** Other AI apps that were read (connections only brought in, never changed there). */
  sources: SourceView[];
  extensions: ExtensionView[];
}

export interface SetupRequest {
  /** Existing client id, or a name for a new client. */
  client: { id: string } | { newName: string };
  /** Candidate keys to bring in. */
  take: string[];
  /** The AI apps to set up. */
  hosts: HostId[];
  /** Catalog tools to add next (from extensions or web connectors); each still needs a sign-in or key. */
  tools: string[];
}

export interface SetupOutcome {
  imported: string[];
  /** Plain-language problems, one per app or connection. */
  problems: string[];
  /** Apps that need a restart to pick up the change. */
  restart: string[];
  /** Plain-language warnings about built-in connectors or extensions for the same services. */
  overlaps: string[];
  /** The client the tools went to, and the catalog tools still to add for it. */
  clientId: string;
  pendingTools: string[];
}

/** Every call resolves; failures carry a plain-language message instead of throwing. */
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface RingkeeperApi {
  getState(): Promise<AppState>;
  addClient(name: string): Promise<Result<ClientView>>;
  renameClient(id: string, name: string): Promise<Result>;
  removeClient(id: string): Promise<Result>;
  setActiveClient(id: string): Promise<Result>;
  addConnection(clientId: string, input: ConnectionInput): Promise<Result<ConnectionView>>;
  updateConnection(clientId: string, connectionId: string, input: ConnectionInput): Promise<Result<ConnectionView>>;
  removeConnection(clientId: string, connectionId: string): Promise<Result>;
  cloneConnection(fromClientId: string, connectionId: string, toClientId: string, keys: Record<string, string>): Promise<Result<ConnectionView>>;
  updateSettings(patch: Partial<Settings>): Promise<Result>;
  scanApps(): Promise<Result<ImportScan>>;
  runSetup(request: SetupRequest): Promise<Result<SetupOutcome>>;
  skipSetup(): Promise<Result>;
  connectApp(host: HostId): Promise<Result<string[]>>;
  moveFound(host: HostId, name: string, clientId: string): Promise<Result>;
  leaveFound(host: HostId, name: string): Promise<Result>;
  restoreApps(): Promise<Result<{ restored: string[]; problems: string[] }>>;
  fixApp(host: HostId): Promise<Result>;
  showAppSettingsFile(host: HostId): Promise<Result>;
  catalogServices(): Promise<Result<CatalogService[]>>;
  addFromCatalog(
    clientId: string,
    serviceId: string,
    optionId: string,
    answers: Record<string, string>,
    name?: string,
  ): Promise<Result<{ connectionId: string; needsSignIn: boolean }>>;
  signIn(clientId: string, connectionId: string): Promise<Result>;
  cancelSignIn(): Promise<Result>;
  openLink(url: string): Promise<Result>;
  /** Stop suggesting a picked tool for a client. */
  dismissPendingTool(clientId: string, toolId: string): Promise<Result>;
  /** Opens an email (or the contact page) to ask for a tool that isn't in the catalog. */
  requestTool(searched: string): Promise<Result>;
  restartToUpdate(): Promise<Result>;
  /** The sign-in address, sent while a sign-in waits, for a "copy link" fallback. */
  onSignInLink(listener: (url: string) => void): () => void;
  onStateChanged(listener: (state: AppState) => void): () => void;
}

export const IPC = {
  call: "ringkeeper:call",
  state: "ringkeeper:state",
  signInLink: "ringkeeper:signin-link",
} as const;

export type ApiMethod = Exclude<keyof RingkeeperApi, "onStateChanged" | "getState" | "onSignInLink">;
