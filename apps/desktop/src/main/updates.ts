// Automatic updates from GitHub Releases (packaged builds only). Updates
// download in the background and install when the app next restarts; the
// user can also restart right away from the tray or the window.
import { autoUpdater } from "electron-updater";
import type { Logger } from "@ringkeeper/gateway";

const CHECK_EVERY_MS = 6 * 60 * 60_000;

export class Updates {
  /** Version downloaded and waiting for a restart. */
  ready?: string;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly deps: {
      log: Logger;
      notify: (title: string, body: string) => void;
      onChange: () => void;
    },
  ) {}

  start(): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("update-downloaded", (info) => {
      this.ready = info.version;
      this.deps.log({ ev: "update_ready", version: info.version });
      this.deps.notify(
        `Ringkeeper Connect ${info.version} is ready`,
        "It installs the next time Ringkeeper Connect restarts. Your clients and connections stay as they are.",
      );
      this.deps.onChange();
    });
    // Failures (offline, unsigned macOS builds) are logged, never shown: the app keeps working.
    autoUpdater.on("error", (err) => this.deps.log({ ev: "update_error", error: String(err).slice(0, 300) }));
    setTimeout(() => this.check(), 30_000).unref();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  check(): void {
    autoUpdater.checkForUpdates().catch((err) => this.deps.log({ ev: "update_check_failed", error: String(err).slice(0, 300) }));
  }

  /** Restart now and install the downloaded update. */
  restartToUpdate(): void {
    if (this.ready) autoUpdater.quitAndInstall(true, true);
  }
}
