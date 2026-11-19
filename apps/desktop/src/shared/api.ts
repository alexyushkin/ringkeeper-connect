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
  /** Clients that already have it in Ringkeeper Connect (same name or same address). */
  inClients: Array<{ clientId: string; clientName: string; same: boolean }>;
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
  /** Per client id: the catalog tools it already has. */
  clientTools: Record<string, string[]>;
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
  /** Online connectors added by their address (Claude's or ChatGPT's own ones can't be read). */
  addresses?: Array<{ name: string; url: string }>;
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
/** Google Cloud pages the "your own Google app" steps open (the only ones the window may open besides the catalog's). */
export const GOOGLE_CONSOLE = "https://console.cloud.google.com";
export const GOOGLE_APIS: Array<[label: string, id: string]> = [
  ["Gmail", "gmail.googleapis.com"],
  ["Drive", "drive.googleapis.com"],
  ["Calendar", "calendar-json.googleapis.com"],
  ["Sheets", "sheets.googleapis.com"],
  ["Docs", "docs.googleapis.com"],
  ["Search Console", "searchconsole.googleapis.com"],
  ["Analytics Data", "analyticsdata.googleapis.com"],
  ["Analytics Admin", "analyticsadmin.googleapis.com"],
  ["YouTube Data", "youtube.googleapis.com"],
  ["YouTube Analytics", "youtubeanalytics.googleapis.com"],
];
export const GOOGLE_CONSOLE_LINKS = [
  `${GOOGLE_CONSOLE}/projectcreate`,
  ...GOOGLE_APIS.map(([, id]) => `${GOOGLE_CONSOLE}/apis/library/${id}`),
  `${GOOGLE_CONSOLE}/auth/branding`,
  `${GOOGLE_CONSOLE}/auth/audience`,
  `${GOOGLE_CONSOLE}/auth/scopes`,
  `${GOOGLE_CONSOLE}/auth/clients`,
];

/** Microsoft Entra's App registrations page, where "your own Microsoft app" is made. */
export const ENTRA_APP_REGISTRATIONS = "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
/** Where the sign-in comes back on this computer (Microsoft ignores the port of these). */
export const MICROSOFT_RETURN_ADDRESS = "http://127.0.0.1/callback";
export const OWN_APP_LINKS = [...GOOGLE_CONSOLE_LINKS, ENTRA_APP_REGISTRATIONS];

/** One of the user's own Google or Microsoft apps, as the window sees it: never its secret. */
export interface OwnAppView {
  id: string;
  vendor: "google" | "microsoft";
  name: string;
  clientId: string;
  /** Microsoft: the directory it signs in to ("common" for any account). */
  tenant?: string;
  /** The tools that sign in through it, as "Acme > Google". */
  usedBy: string[];
}

export interface OwnAppInput {
  /** On an add: whose app it is. */
  vendor?: "google" | "microsoft";
  name?: string;
  clientId?: string;
  /** Google only. Left empty on an edit: keep the saved one. */
  clientSecret?: string;
  /** Microsoft only: a directory (tenant) ID; empty for any account. */
  tenant?: string;
}

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
    /** The ticked "what the AI may do" boxes, for a tool that has them. */
    access?: string[],
    /** Which app it signs in through: one of the option's signInApps (the first when left out). */
    appId?: string,
  ): Promise<Result<{ connectionId: string; needsSignIn: boolean }>>;
  signIn(clientId: string, connectionId: string): Promise<Result>;
  /** Rename one of Ringkeeper Connect's own tools, or change what the AI may do with it. */
  editBuiltIn(clientId: string, connectionId: string, name: string, access?: string[]): Promise<Result<{ needsSignIn: boolean }>>;
  /** The user's own Google apps (never their secrets). */
  listOwnApps(): Promise<Result<OwnAppView[]>>;
  addOwnApp(input: OwnAppInput): Promise<Result<OwnAppView>>;
  updateOwnApp(id: string, input: OwnAppInput): Promise<Result<OwnAppView>>;
  removeOwnApp(id: string): Promise<Result>;
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

/** In a sign-in error: the service only lets apps it approved sign in, so trying again can't help (same text as the gateway's NOT_APPROVED). */
export const NOT_APPROVED = "only lets apps it has approved sign in";
