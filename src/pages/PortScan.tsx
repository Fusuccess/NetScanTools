import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, portStateLabel } from "../lib/copy";
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
  const [copied, setCopied] = useState("");
  const [owned, setOwned] = useState(false);
  const ownedRef = useRef(false);

  useEffect(() => {
    if (target) setIp(target);
  }, [target]);

  useEffect(() => {
    const off = [
      watchScanProgress((p) => {
        if (!ownedRef.current) return;
        setDone(p.done);
        setTotal(p.total);
        setOpen(p.open);
        setClosed(p.closed);
        setTimeoutN(p.timeout);
      }),
      watchScanPort((r) => {
        if (!ownedRef.current) return;
        setRows((prev) => {
          const i = prev.findIndex((x) => x.port === r.port);
          if (i < 0) return [...prev, r];
          const next = [...prev];
          next[i] = r;
          return next;
        });
      }),
      watchScanFinished((p) => {
        if (!ownedRef.current) return;
        ownedRef.current = false;
        setOwned(false);
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
    ownedRef.current = true;
    setOwned(true);
    setScanning(true);
    try {
      await api.startPortScan({ ip, ports: portsSpec(), timeoutMs, concurrency });
    } catch (e) {
      ownedRef.current = false;
      setOwned(false);
      setScanning(false);
      setError(String(e));
    }
  }

  const status = owned ? "扫描中" : finished ? "已完成" : "就绪";
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

  async function copyValue(text: string, label: string) {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1500);
    }
  }

  async function copyResults() {
    const header = ["端口", "协议", "状态", "服务", "横幅"].join("\t");
    const lines = visible.map((r) =>
      [r.port, r.proto, portStateLabel(r.state), r.service || "", r.banner || ""].join("\t"),
    );
    await copyValue([header, ...lines].join("\n"), "已复制结果");
  }

  function emptyHint() {
    if (owned && rows.length === 0) return "扫描中，结果会陆续出现。";
    if (owned) return "当前筛选还没有匹配项，扫描仍在进行。";
    if (rows.length === 0) return "还没有扫描结果。填写目标 IP 后点「开始扫描」。";
    if (filter === "open") return "没有开放端口。可改看「全部」或「超时」。";
    if (filter === "closed") return "没有关闭的端口。无响应会记为超时。";
    if (filter === "timeout") return "没有超时的端口。";
    return "当前筛选没有匹配的端口。";
  }

  return (
    <div className="page page-fill">
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
        {owned && scanning && <button className="btn" onClick={() => api.cancelScan()}>取消</button>}
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
        <button className="btn" disabled={!visible.length} onClick={() => void copyResults()}>复制结果</button>
        {copied && <span>{copied}</span>}
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
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>端口</th><th>协议</th><th>状态</th><th>服务</th><th>横幅</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td className="placeholder" colSpan={5}>{emptyHint()}</td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={`${r.port}-${r.state}`}>
                <td>
                  <span className="copyable" title="点击复制" onClick={() => void copyValue(String(r.port), "已复制端口")}>{r.port}</span>
                </td>
                <td>{r.proto}</td>
                <td className={r.state === "open" ? "dot" : "dot bad"}>
                  {portStateLabel(r.state)}
                </td>
                <td>{r.service || "-"}</td>
                <td>
                  {r.banner ? (
                    <span className="copyable" title="点击复制" onClick={() => void copyValue(r.banner, "已复制横幅")}>{r.banner}</span>
                  ) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
