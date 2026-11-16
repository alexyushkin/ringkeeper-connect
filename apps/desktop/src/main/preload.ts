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
  onStateChanged: (listener) => {
    const handler = (_e: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
};

contextBridge.exposeInMainWorld("ringkeeper", api);
