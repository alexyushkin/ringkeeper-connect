// Automatic updates from GitHub Releases (packaged builds only). Checked 30 seconds after
// starting and every 6 hours (as Ringkeeper does); a failed check tries again after 15
// minutes, since the usual cause is a release still being published. Updates download in
// the background and install when the app next restarts; the user can also restart right
// away from the window or the tray, or check by hand and see what happened.
import { autoUpdater } from "electron-updater";
import type { Logger } from "@ringkeeper/gateway";
import type { UpdateState } from "../shared/api.js";

export const CHECK_EVERY_MS = 6 * 60 * 60_000;
export const RETRY_AFTER_MS = 15 * 60_000;
const FIRST_CHECK_MS = 30_000;

/** What Updates needs of electron-updater's autoUpdater (a stand-in in tests). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** A failed check in words: a release still being published, or no internet. */
export function failureText(error: unknown): string {
  const text = String(error);
  if (/latest(-mac|-linux)?\.yml/i.test(text) && /404/.test(text)) return "A new version is still being published. Trying again in 15 minutes.";
  return "Couldn't check for updates. Check your internet connection; it tries again in 15 minutes.";
}

export class Updates {
  /** Version downloaded and waiting for a restart. */
  ready?: string;
  state: UpdateState = { status: "idle" };
  private timer?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  /** The person asked: tell them how it went, even when there's nothing new. */
  private asked = false;
  private readonly updater: Updater;

  constructor(
    private readonly deps: {
      log: Logger;
      notify: (title: string, body: string) => void;
      onChange: () => void;
      updater?: Updater;
      now?: () => number;
    },
  ) {
    this.updater = deps.updater ?? (autoUpdater as unknown as Updater);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.deps.onChange();
  }

  start(): void {
    const u = this.updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.logger = null;
    u.on("checking-for-update", () => this.set({ status: "checking" }));
    u.on("update-available", (info: { version: string }) => this.set({ status: "downloading", version: info.version }));
    u.on("update-not-available", () => {
      this.set({ status: "up-to-date", checkedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString() });
      if (this.asked) this.deps.notify("Ringkeeper Connect is up to date", "You have the newest version.");
      this.asked = false;
    });
    u.on("update-downloaded", (info: { version: string }) => {
      this.ready = info.version;
      this.asked = false;
      this.deps.log({ ev: "update_ready", version: info.version });
      this.deps.notify(
        `Ringkeeper Connect ${info.version} is ready`,
        "It installs the next time Ringkeeper Connect restarts. Your clients and connections stay as they are.",
      );
      this.set({ status: "ready", version: info.version });
    });
    // The app keeps working whatever happens here; a failure is logged, shown quietly, and retried.
    u.on("error", (err: unknown) => this.failed(err));
    setTimeout(() => this.check(), FIRST_CHECK_MS).unref();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  private failed(err: unknown): void {
    this.deps.log({ ev: "update_error", error: String(err).slice(0, 300) });
    if (this.ready) return;
    const message = failureText(err);
    if (this.asked) this.deps.notify("Couldn't check for updates", message);
    this.asked = false;
    this.set({ status: "failed", message });
    if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.check();
      }, RETRY_AFTER_MS);
      this.retry.unref();
    }
  }

  /** Check now. `asked`: the person clicked Check for updates, so say how it went. */
  check(asked = false): void {
    if (this.ready) return;
    if (asked) this.asked = true;
    if (this.state.status === "checking" || this.state.status === "downloading") return;
    this.updater.checkForUpdates().catch((err) => {
      this.deps.log({ ev: "update_check_failed", error: String(err).slice(0, 300) });
      // electron-updater usually emits "error" too; make sure the state says so either way.
      if (this.state.status !== "failed") this.failed(err);
    });
  }

  /**
   * Restart now and install the downloaded update. Installing takes a minute or two on
   * Windows, so the installer shows its progress (not silent) and opens the app again
   * when it's done; a silent install left nothing on screen for that time, and looked
   * as if the app had closed for good.
   */
  restartToUpdate(): void {
    if (!this.ready) return;
    this.deps.log({ ev: "update_restart", version: this.ready });
    this.deps.notify(
      `Installing Ringkeeper Connect ${this.ready}`,
      "It opens again by itself when it's done, in a minute or two. Your clients and connections stay as they are.",
    );
    this.updater.quitAndInstall(false, true);
  }
}
