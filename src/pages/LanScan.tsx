import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { copyText, scanHotkey } from "../lib/copy";
import { api, watchScanFinished, watchScanHost, watchScanProgress } from "../lib/tauri";
import type { HostRow, Nic, Settings } from "../lib/types";

type Props = {
  nics: Nic[];
  nic: Nic | null;
  onNic: (n: Nic) => void;
  onRefreshNics: () => void;
  nicsBusy: boolean;
  settings: Settings;
  active: boolean;
  scanning: boolean;
  setScanning: (v: boolean) => void;
  onJumpPort: (ip: string) => void;
};

export default function LanScan({ nics, nic, onNic, onRefreshNics, nicsBusy, settings, active, scanning, setScanning, onJumpPort }: Props) {
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
  const [copied, setCopied] = useState("");
  const [owned, setOwned] = useState(false);
  const ownedRef = useRef(false);

  useEffect(() => {
    if (nic && !scanning) setRange(nic.cidrHint);
  }, [nic?.cidrHint]);

  useEffect(() => {
    let t: number | undefined;
    if (owned && scanning) {
      const start = Date.now();
      t = window.setInterval(() => setElapsed((Date.now() - start) / 1000), 200);
    }
    return () => clearInterval(t);
  }, [owned, scanning]);

  useEffect(() => {
    const off = [
      watchScanProgress((p) => {
        if (!ownedRef.current) return;
        setDone(p.done);
        setTotal(p.total);
      }),
      watchScanHost((h) => {
        if (!ownedRef.current) return;
        setHosts((prev) => {
          const i = prev.findIndex((x) => x.ip === h.ip);
          if (i < 0) return [...prev, h];
          const next = [...prev];
          next[i] = h;
          return next;
        });
      }),
      watchScanFinished((p) => {
        if (!ownedRef.current) return;
        ownedRef.current = false;
        setOwned(false);
        setScanning(false);
        if (p.error) setError(p.error);
      }),
    ];
    return () => off.forEach((u) => u());
  }, [setScanning]);

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (!scanning) void start();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, scanning, range, timeoutMs, concurrency]);

  const pct = total ? Math.round((done / total) * 100) : 0;
  const canStart = useMemo(() => !!range && !scanning, [range, scanning]);

  async function start() {
    setError("");
    setHosts([]);
    setDone(0);
    setTotal(0);
    ownedRef.current = true;
    setOwned(true);
    setScanning(true);
    try {
      await api.startLanScan({ range, icmp: true, tcpProbe: false, timeoutMs, concurrency });
    } catch (e) {
      ownedRef.current = false;
      setOwned(false);
      setScanning(false);
      setError(String(e));
    }
  }

  async function copyValue(text: string, label: string) {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1500);
    }
  }

  async function copyResults() {
    const header = ["IP", "主机名", "MAC", "厂商"].join("\t");
    const lines = hosts.map((h) => [h.ip, h.hostname || "", h.mac || "", h.vendor || ""].join("\t"));
    await copyValue([header, ...lines].join("\n"), "已复制结果");
  }

  const emptyHint = owned
    ? "扫描中，在线设备会陆续出现。"
    : "还没有扫描结果。选择网段后点「开始扫描」。";

  return (
    <div className="page page-fill">
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
          开始扫描 ({scanHotkey})
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
        {owned && scanning && <button className="btn" onClick={() => api.cancelScan()}>取消</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="stats">
        在线设备: {hosts.length} 台 | 耗时: {elapsed.toFixed(1)}s
        <button className="btn" disabled={!hosts.length} onClick={() => void copyResults()}>复制结果</button>
        {copied && <span>{copied}</span>}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>状态</th><th>IP 地址</th><th>主机名</th><th>MAC 地址</th><th>厂商</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {hosts.length === 0 && (
              <tr>
                <td className="placeholder" colSpan={6}>{emptyHint}</td>
              </tr>
            )}
            {hosts.map((h) => (
              <Fragment key={h.ip}>
                <tr onClick={() => setOpenIp(openIp === h.ip ? null : h.ip)}>
                  <td className="dot">●</td>
                  <td>
                    <span className="copyable" title="点击复制" onClick={(e) => { e.stopPropagation(); void copyValue(h.ip, "已复制 IP"); }}>{h.ip}</span>
                  </td>
                  <td>{h.hostname || "-"}</td>
                  <td>
                    {h.mac ? (
                      <span className="copyable" title="点击复制" onClick={(e) => { e.stopPropagation(); void copyValue(h.mac || "", "已复制 MAC"); }}>{h.mac}</span>
                    ) : "-"}
                  </td>
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
    </div>
  );
}
