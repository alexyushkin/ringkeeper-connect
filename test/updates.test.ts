// Checking for updates: every 6 hours (as Ringkeeper), again 15 minutes after a failed check,
// and, when the person clicks Check for updates, a word on how it went.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, RETRY_AFTER_MS, Updates, failureText, type Updater } from "../apps/desktop/src/main/updates.js";
import { updateStatusText } from "../apps/desktop/src/shared/api.js";

afterEach(() => vi.useRealTimers());

/** A stand-in for electron-updater: each check runs `next`. */
function fakeUpdater(next: (u: FakeUpdater) => void) {
  const u = new EventEmitter() as FakeUpdater;
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.logger = undefined;
  u.checks = 0;
  u.installed = 0;
  u.checkForUpdates = async () => {
    u.checks++;
    u.emit("checking-for-update");
    next(u);
    return {};
  };
  u.quitAndInstall = () => void u.installed++;
  return u;
}
type FakeUpdater = EventEmitter & Updater & { checks: number; installed: number };

function setup(next: (u: FakeUpdater) => void) {
  const notes: string[] = [];
  const updater = fakeUpdater(next);
  const updates = new Updates({ log: () => {}, notify: (title) => notes.push(title), onChange: () => {}, updater });
  return { updates, updater, notes };
}

const LATE_YML = new Error(
  "Cannot find latest.yml in the latest release artifacts (https://github.com/alexyushkin/ringkeeper-connect/releases/download/v0.2.0-beta.15/latest.yml): HttpError: 404",
);

describe("checking for updates", () => {
  it("checks 30 seconds after starting, then every 6 hours, not more often", async () => {
    vi.useFakeTimers();
    const t = setup((u) => u.emit("update-not-available", {}));
    t.updates.start();
    expect(t.updater.autoDownload).toBe(true);
    expect(t.updater.autoInstallOnAppQuit).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 30_000 - 1);
    expect(t.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.updater.checks).toBe(2);
    expect(CHECK_EVERY_MS).toBe(6 * 60 * 60_000);
    // Nothing found on its own: nobody is bothered.
    expect(t.notes).toEqual([]);
    expect(t.updates.state.status).toBe("up-to-date");
  });

  it("tries again 15 minutes after a failed check, once", async () => {
    vi.useFakeTimers();
    let fail = true;
    const t = setup((u) => (fail ? u.emit("error", LATE_YML) : u.emit("update-available", { version: "0.2.0-beta.17" })));
    t.updates.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.updates.state).toEqual({ status: "failed", message: "A new version is still being published. Trying again in 15 minutes." });
    expect(t.notes).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    expect(t.updater.checks).toBe(2);
    expect(t.updates.state).toEqual({ status: "downloading", version: "0.2.0-beta.17" });
    // No more retries once one worked.
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 2);
    expect(t.updater.checks).toBe(2);
  });

  it("when asked, says it's up to date or that it couldn't check", async () => {
    let result: (u: FakeUpdater) => void = (u) => u.emit("update-not-available", {});
    const t = setup((u) => result(u));
    t.updates.start();
    t.updates.check(true);
    await Promise.resolve();
    expect(t.notes).toEqual(["Ringkeeper Connect is up to date"]);
    expect(updateStatusText(t.updates.state)).toBe("Up to date.");

    result = (u) => u.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    t.updates.check(true);
    await Promise.resolve();
    expect(t.notes.at(-1)).toBe("Couldn't check for updates");
    expect(updateStatusText(t.updates.state)).toBe("Couldn't check for updates. Check your internet connection; it tries again in 15 minutes.");
  });

  it("shows the download, then the ready version, and restarts into it", async () => {
    const t = setup((u) => {
      u.emit("update-available", { version: "0.2.0-beta.18" });
      u.emit("update-downloaded", { version: "0.2.0-beta.18" });
    });
    t.updates.start();
    t.updates.check(true);
    await Promise.resolve();
    expect(t.updates.ready).toBe("0.2.0-beta.18");
    expect(updateStatusText(t.updates.state)).toBe("0.2.0-beta.18 is ready.");
    expect(t.notes).toEqual(["Ringkeeper Connect 0.2.0-beta.18 is ready"]);
    // Ready: no more checking; restarting installs it.
    t.updates.check(true);
    expect(t.updater.checks).toBe(1);
    t.updates.restartToUpdate();
    expect(t.updater.installed).toBe(1);
  });

  it("puts a failure in plain words", () => {
    expect(failureText(LATE_YML)).toMatch(/still being published/);
    expect(failureText(new Error("getaddrinfo ENOTFOUND github.com"))).toMatch(/Check your internet connection/);
    expect(updateStatusText({ status: "checking" })).toBe("Checking for updates…");
    expect(updateStatusText({ status: "idle" })).toBeNull();
    expect(updateStatusText(undefined)).toBeNull();
  });
});
