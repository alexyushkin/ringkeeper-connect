// Exposes a small, typed API to the window. No Node access leaks through.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ApiMethod, type AppState, type RingkeeperApi } from "../shared/api.js";

const call =
  (method: ApiMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.call, method, args);

const api: RingkeeperApi = {
  getState: () => ipcRenderer.invoke(IPC.state),
  addClient: call("addClient") as RingkeeperApi["addClient"],
  renameClient: call("renameClient") as RingkeeperApi["renameClient"],
  removeClient: call("removeClient") as RingkeeperApi["removeClient"],
  setActiveClient: call("setActiveClient") as RingkeeperApi["setActiveClient"],
  addConnection: call("addConnection") as RingkeeperApi["addConnection"],
  updateConnection: call("updateConnection") as RingkeeperApi["updateConnection"],
  removeConnection: call("removeConnection") as RingkeeperApi["removeConnection"],
  cloneConnection: call("cloneConnection") as RingkeeperApi["cloneConnection"],
  updateSettings: call("updateSettings") as RingkeeperApi["updateSettings"],
  scanApps: call("scanApps") as RingkeeperApi["scanApps"],
  runSetup: call("runSetup") as RingkeeperApi["runSetup"],
  skipSetup: call("skipSetup") as RingkeeperApi["skipSetup"],
  connectApp: call("connectApp") as RingkeeperApi["connectApp"],
  moveFound: call("moveFound") as RingkeeperApi["moveFound"],
  leaveFound: call("leaveFound") as RingkeeperApi["leaveFound"],
  restoreApps: call("restoreApps") as RingkeeperApi["restoreApps"],
  catalogServices: call("catalogServices") as RingkeeperApi["catalogServices"],
  addFromCatalog: call("addFromCatalog") as RingkeeperApi["addFromCatalog"],
  signIn: call("signIn") as RingkeeperApi["signIn"],
  cancelSignIn: call("cancelSignIn") as RingkeeperApi["cancelSignIn"],
  openLink: call("openLink") as RingkeeperApi["openLink"],
  restartToUpdate: call("restartToUpdate") as RingkeeperApi["restartToUpdate"],
  onSignInLink: (listener) => {
    const handler = (_e: unknown, url: string) => listener(url);
    ipcRenderer.on(IPC.signInLink, handler);
    return () => ipcRenderer.removeListener(IPC.signInLink, handler);
  },
  onStateChanged: (listener) => {
    const handler = (_e: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
};

contextBridge.exposeInMainWorld("ringkeeper", api);
