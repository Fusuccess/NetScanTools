import { useEffect, useMemo, useState } from "react";
import { api, watchScanFinished, watchScanPort, watchScanProgress } from "../lib/tauri";
import { COMMON_PORTS, type PortRow, type Settings } from "../lib/types";

type StatusFilter = "all" | "open" | "closed" | "timeout";

type Props = {
  settings: Settings;
  target: string;
  scanning: boolean;
  setScanning: (v: boolean) => void;
};

export default function PortScan({ settings, target, scanning, setScanning }: Props) {
  const [ip, setIp] = useState(target);
  const [timeoutMs, setTimeoutMs] = useState(settings.timeoutMs);
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [preset, setPreset] = useState<"common" | "1-1024" | "1-65535" | "custom">("common");
  const [custom, setCustom] = useState(COMMON_PORTS);
  const [rows, setRows] = useState<PortRow[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(0);
  const [closed, setClosed] = useState(0);
  const [timeoutN, setTimeoutN] = useState(0);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("open");

  useEffect(() => {
    if (target) setIp(target);
  }, [target]);

  useEffect(() => {
    const off = [
      watchScanProgress((p) => {
        setDone(p.done);
        setTotal(p.total);
        setOpen(p.open);
        setClosed(p.closed);
        setTimeoutN(p.timeout);
      }),
      watchScanPort((r) =>
        setRows((prev) => {
          const i = prev.findIndex((x) => x.port === r.port);
          if (i < 0) return [...prev, r];
          const next = [...prev];
          next[i] = r;
          return next;
        }),
      ),
      watchScanFinished((p) => {
        setScanning(false);
        setFinished(true);
        if (p.error) setError(p.error);
      }),
    ];
    return () => off.forEach((u) => u());
  }, [setScanning]);

  function portsSpec() {
    if (preset === "common") return settings.commonPorts.join(",") || COMMON_PORTS;
    if (preset === "1-1024") return "1-1024";
    if (preset === "1-65535") return "1-65535";
    return custom;
  }

  async function start() {
    setError("");
    setRows([]);
    setDone(0);
    setTotal(0);
    setOpen(0);
    setClosed(0);
    setTimeoutN(0);
    setFinished(false);
    setFilter("open");
    setScanning(true);
    try {
      await api.startPortScan({ ip, ports: portsSpec(), timeoutMs, concurrency });
    } catch (e) {
      setScanning(false);
      setError(String(e));
    }
  }

  const status = scanning ? "扫描中" : finished ? "已完成" : "就绪";
  const pct = total ? Math.round((done / total) * 100) : 0;
  const visible = useMemo(() => {
    const list = filter === "all" ? rows : rows.filter((r) => r.state === filter);
    return [...list].sort((a, b) => a.port - b.port);
  }, [rows, filter]);
  const counts = useMemo(
    () => ({
      all: rows.length,
      open: rows.filter((r) => r.state === "open").length,
      closed: rows.filter((r) => r.state === "closed").length,
      timeout: rows.filter((r) => r.state === "timeout").length,
    }),
    [rows],
  );

  return (
    <div className="page">
      <h1>端口扫描</h1>
      <div className="toolbar">
        <label className="field grow">
          目标 IP:
          <input value={ip} onChange={(e) => setIp(e.target.value)} />
        </label>
        <label className="field">超时(ms): <input type="number" value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} /></label>
        <label className="field">并发数: <input type="number" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} /></label>
      </div>
      <div className="toolbar">
        端口预设:
        {(["common", "1-1024", "1-65535", "custom"] as const).map((p) => (
          <button key={p} className={`btn ${preset === p ? "primary" : ""}`} onClick={() => setPreset(p)}>
            {p === "common" ? "常用端口" : p === "custom" ? "自定义" : p}
          </button>
        ))}
        <button className="btn primary" disabled={scanning || !ip} onClick={start}>开始扫描</button>
        {scanning && <button className="btn" onClick={() => api.cancelScan()}>取消</button>}
      </div>
      {preset === "custom" && (
        <div className="toolbar">
          <label className="field grow">
            自定义端口:
            <input value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="progress">
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <span>{pct}% ({done}/{total || 0})</span>
      </div>
      <div className="stats">
        扫描状态: {status}
        {` | 开放 ${open} / 关闭 ${closed} / 超时 ${timeoutN}`}
      </div>
      <div className="toolbar">
        结果筛选:
        {(
          [
            ["all", "全部", counts.all],
            ["open", "开放", counts.open],
            ["closed", "关闭", counts.closed],
            ["timeout", "超时", counts.timeout],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            className={`btn ${filter === id ? "primary" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label} ({count})
          </button>
        ))}
      </div>
      <p className="muted">关闭是对端拒绝连接；无响应会记为超时，请看「超时」而不是「关闭」。</p>
      <table className="data">
        <thead>
          <tr>
            <th>端口</th><th>协议</th><th>状态</th><th>Known Service</th><th>Banner 探针响应</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={`${r.port}-${r.state}`}>
              <td>{r.port}</td>
              <td>{r.proto}</td>
              <td className={r.state === "open" ? "dot" : "dot bad"}>
                {r.state === "open" ? "OPEN" : r.state === "closed" ? "CLOSED" : "TIMEOUT"}
              </td>
              <td>{r.service || "-"}</td>
              <td>{r.banner || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
