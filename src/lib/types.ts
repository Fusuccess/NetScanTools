export type Nic = {
  name: string;
  ipv4: string;
  cidrHint: string;
};

export type Settings = {
  timeoutMs: number;
  concurrency: number;
  commonPorts: number[];
  defaultIcmp: boolean;
  defaultTcp: boolean;
  theme: "light" | "dark";
};

export type ProbePort = { port: number; banner: string };

export type HostRow = {
  ip: string;
  hostname?: string | null;
  mac?: string | null;
  vendor?: string | null;
  rttMs?: number | null;
  arpKind?: string | null;
  probePorts: ProbePort[];
};

export type PortRow = {
  port: number;
  proto: string;
  state: string;
  service: string;
  banner: string;
};

export type ScanProgress = {
  taskId: string;
  done: number;
  total: number;
  open: number;
  closed: number;
  timeout: number;
};

export type SshTunnel = {
  id: string;
  alias: string;
  localBind: string;
  localPort: number;
  jumpHost: string;
  jumpPort: number;
  username: string;
  auth: "password" | "key";
  keyPath: string;
  targetHost: string;
  targetPort: number;
  status: "running" | "stopped" | "error";
  uptimeSecs: number;
  lastError?: string | null;
};

export type SshLog = {
  id: string;
  ts: string;
  level: string;
  message: string;
};

export type PortMap = {
  id: string;
  bindIp: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  status: "running" | "stopped" | "error";
  connections: number;
  lastError?: string | null;
};

export const COMMON_PORTS =
  "21,22,23,25,53,80,110,139,143,443,445,3306,3389,5432,5900,6379,8080,8443";
