import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HostRow, Nic, PortMap, PortRow, ScanProgress, Settings, SshLog, SshTunnel } from "./types";

export const api = {
  listNics: () => invoke<Nic[]>("list_nics"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  startLanScan: (req: {
    range: string;
    icmp: boolean;
    tcpProbe: boolean;
    timeoutMs: number;
    concurrency: number;
  }) => invoke<{ taskId: string }>("start_lan_scan", { req }),
  startPortScan: (req: {
    ip: string;
    ports: string;
    timeoutMs: number;
    concurrency: number;
  }) => invoke<{ taskId: string }>("start_port_scan", { req }),
  cancelScan: () => invoke("cancel_scan"),
  listTunnels: () => invoke<SshTunnel[]>("list_tunnels"),
  pickSshKey: () => invoke<string | null>("pick_ssh_key"),
  saveTunnel: (config: Partial<SshTunnel> & Record<string, unknown>) =>
    invoke<SshTunnel>("save_tunnel", { config }),
  startTunnel: (id: string, password?: string) =>
    invoke("start_tunnel", { arg: { id, password } }),
  stopTunnel: (id: string) => invoke("stop_tunnel", { arg: { id } }),
  deleteTunnel: (id: string) => invoke("delete_tunnel", { arg: { id } }),
  listForwards: () => invoke<PortMap[]>("list_forwards"),
  saveForward: (config: Partial<PortMap> & Record<string, unknown>) =>
    invoke<PortMap>("save_forward", { config }),
  startForward: (id: string) => invoke("start_forward", { arg: { id } }),
  stopForward: (id: string) => invoke("stop_forward", { arg: { id } }),
  deleteForward: (id: string) => invoke("delete_forward", { arg: { id } }),
  openAuthorSite: () => invoke("open_author_site"),
};

function watch<T>(name: string, cb: (p: T) => void): () => void {
  let cancelled = false;
  let unlisten: UnlistenFn | undefined;
  listen<T>(name, (e) => cb(e.payload))
    .then((u) => {
      if (cancelled) u();
      else unlisten = u;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export const watchScanProgress = (cb: (p: ScanProgress) => void) => watch("scan:progress", cb);
export const watchScanHost = (cb: (h: HostRow) => void) => watch("scan:host", cb);
export const watchScanPort = (cb: (r: PortRow) => void) => watch("scan:port", cb);
export const watchScanFinished = (cb: (p: { taskId: string; error?: string | null }) => void) =>
  watch("scan:finished", cb);
export const watchSshLog = (cb: (l: SshLog) => void) => watch("ssh:log", cb);
export const watchSshStatus = (cb: (p: { id: string; status: string; lastError?: string | null }) => void) =>
  watch("ssh:status", cb);
export const watchForwardStatus = (cb: (p: { id: string; status: string; connections?: number; lastError?: string | null }) => void) =>
  watch("forward:status", cb);
