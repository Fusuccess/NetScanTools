import { Fragment, useEffect, useMemo, useState } from "react";
import { api, watchScanFinished, watchScanHost, watchScanProgress } from "../lib/tauri";
import type { HostRow, Nic, Settings } from "../lib/types";

type Props = {
  nics: Nic[];
  nic: Nic | null;
  onNic: (n: Nic) => void;
  onRefreshNics: () => void;
  nicsBusy: boolean;
  settings: Settings;
  scanning: boolean;
  setScanning: (v: boolean) => void;
  onJumpPort: (ip: string) => void;
};

export default function LanScan({ nics, nic, onNic, onRefreshNics, nicsBusy, settings, scanning, setScanning, onJumpPort }: Props) {
  const [range, setRange] = useState(nic?.cidrHint ?? "");
  const [showParams, setShowParams] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(settings.timeoutMs);
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [openIp, setOpenIp] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (nic && !scanning) setRange(nic.cidrHint);
  }, [nic?.cidrHint]);

  useEffect(() => {
    let t: number | undefined;
    if (scanning) {
      const start = Date.now();
      t = window.setInterval(() => setElapsed((Date.now() - start) / 1000), 200);
    }
    return () => clearInterval(t);
  }, [scanning]);

  useEffect(() => {
    const off = [
      watchScanProgress((p) => {
        setDone(p.done);
        setTotal(p.total);
      }),
      watchScanHost((h) =>
        setHosts((prev) => {
          const i = prev.findIndex((x) => x.ip === h.ip);
          if (i < 0) return [...prev, h];
          const next = [...prev];
          next[i] = h;
          return next;
        }),
      ),
      watchScanFinished((p) => {
        setScanning(false);
        if (p.error) setError(p.error);
      }),
    ];
    return () => off.forEach((u) => u());
  }, [setScanning]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (!scanning) void start();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scanning, range, timeoutMs, concurrency]);

  const pct = total ? Math.round((done / total) * 100) : 0;
  const canStart = useMemo(() => !!range && !scanning, [range, scanning]);

  async function start() {
    setError("");
    setHosts([]);
    setDone(0);
    setTotal(0);
    setScanning(true);
    try {
      await api.startLanScan({ range, icmp: true, tcpProbe: false, timeoutMs, concurrency });
    } catch (e) {
      setScanning(false);
      setError(String(e));
    }
  }

  return (
    <div className="page">
      <h1>局域网扫描</h1>
      <div className="toolbar">
        <label className="field">
          网卡:
          <select
            value={nic ? `${nic.name}|${nic.ipv4}` : ""}
            onChange={(e) => {
              const n = nics.find((x) => `${x.name}|${x.ipv4}` === e.target.value);
              if (n) onNic(n);
            }}
          >
            {nics.map((n) => (
              <option key={`${n.name}|${n.ipv4}`} value={`${n.name}|${n.ipv4}`}>
                {n.name} ({n.ipv4})
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={nicsBusy} onClick={() => void onRefreshNics()}>
          {nicsBusy ? "刷新中" : "刷新网卡"}
        </button>
        <label className="field grow">
          网段:
          <input value={range} onChange={(e) => setRange(e.target.value)} />
        </label>
        <button className="btn" onClick={() => setShowParams((v) => !v)}>
          探测参数
        </button>
        <button className="btn primary" disabled={!canStart} onClick={start}>
          开始扫描 (Ctrl+R)
        </button>
      </div>
      {showParams && (
        <div className="toolbar">
          <label className="field">超时(ms) <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} /></label>
          <label className="field">并发 <input type="number" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} /></label>
        </div>
      )}
      <div className="progress">
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <span>{pct}% ({done}/{total || 0})</span>
        {scanning && <button className="btn" onClick={() => api.cancelScan()}>取消</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="stats">在线设备: {hosts.length} 台 | 耗时: {elapsed.toFixed(1)}s</div>
      <table className="data">
        <thead>
          <tr>
            <th>状态</th><th>IP 地址</th><th>主机名</th><th>MAC 地址</th><th>厂商</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <Fragment key={h.ip}>
              <tr onClick={() => setOpenIp(openIp === h.ip ? null : h.ip)}>
                <td className="dot">●</td>
                <td>{h.ip}</td>
                <td>{h.hostname || "-"}</td>
                <td>{h.mac || "-"}</td>
                <td>{h.vendor || "-"}</td>
                <td>
                  <button className="btn" onClick={(e) => { e.stopPropagation(); onJumpPort(h.ip); }}>端口扫描</button>
                </td>
              </tr>
              {openIp === h.ip && (
                <tr>
                  <td colSpan={6}>
                    <div className="detail">
                      详情: 响应延时 {h.rttMs ?? "-"}ms | ARP 状态: {h.arpKind ?? "-"}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
