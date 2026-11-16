// The contract between the window and the main process. Secret values only
// ever travel window → main (when the user types a key), never back.
import type { ClientView, ConnectionInput, ConnectionView, Settings } from "@ringkeeper/gateway/store";
import type { ConnectionStatus } from "@ringkeeper/gateway";

export type { ClientView, ConnectionInput, ConnectionView, Settings, ConnectionStatus };

export type HostId = "claude-desktop" | "cursor" | "claude-code";

export interface HostView {
  id: HostId;
  label: string;
  status: "not_installed" | "not_connected" | "connected" | "unreadable";
  problem?: string;
  otherConnections: string[];
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

export interface ImportScan {
  hosts: HostView[];
  candidates: ImportCandidateView[];
}

export interface SetupRequest {
  /** Existing client id, or a name for a new client. */
  client: { id: string } | { newName: string };
  /** Candidate keys to bring in. */
  take: string[];
}

export interface SetupOutcome {
  imported: string[];
  /** Plain-language problems, one per app or connection. */
  problems: string[];
  /** Apps that need a restart to pick up the change. */
  restart: string[];
  /** Plain-language warnings about built-in connectors or extensions for the same services. */
  overlaps: string[];
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
  onStateChanged(listener: (state: AppState) => void): () => void;
}

export const IPC = {
  call: "ringkeeper:call",
  state: "ringkeeper:state",
} as const;

export type ApiMethod = Exclude<keyof RingkeeperApi, "onStateChanged" | "getState">;
