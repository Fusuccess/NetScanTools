import { useEffect, useState } from "react";
import { api, watchSshLog, watchSshStatus } from "../lib/tauri";
import type { SshLog, SshTunnel } from "../lib/types";

const empty = (): Partial<SshTunnel> => ({
  id: "",
  alias: "",
  localBind: "127.0.0.1",
  localPort: 3306,
  jumpHost: "",
  jumpPort: 22,
  username: "",
  auth: "password",
  keyPath: "",
  targetHost: "",
  targetPort: 3306,
});

export default function SshTunnels({ onRunningCount }: { onRunningCount: (n: number) => void }) {
  const [tunnels, setTunnels] = useState<SshTunnel[]>([]);
  const [logs, setLogs] = useState<SshLog[]>([]);
  const [logId, setLogId] = useState<string | null>(null);
  const [modal, setModal] = useState<Partial<SshTunnel> | null>(null);
  const [password, setPassword] = useState("");
  const [askPass, setAskPass] = useState<SshTunnel | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    const list = await api.listTunnels();
    setTunnels(list);
    onRunningCount(list.filter((t) => t.status === "running").length);
  }

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
    const off = [
      watchSshLog((l) => {
        setLogs((prev) => [...prev.slice(-200), l]);
        setLogId((id) => id ?? l.id);
      }),
      watchSshStatus(() => {
        reload().catch(() => {});
      }),
    ];
    return () => off.forEach((u) => u());
  }, []);

  async function toggle(t: SshTunnel) {
    setError("");
    try {
      if (t.status === "running") {
        await api.stopTunnel(t.id);
      } else if (t.auth === "password") {
        setAskPass(t);
        return;
      } else {
        await api.startTunnel(t.id);
      }
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function save(start: boolean) {
    if (!modal) return;
    setError("");
    try {
      const saved = await api.saveTunnel({
        id: modal.id || "",
        alias: modal.alias,
        localBind: "127.0.0.1",
        localPort: Number(modal.localPort),
        jumpHost: modal.jumpHost,
        jumpPort: Number(modal.jumpPort),
        username: modal.username,
        auth: modal.auth,
        keyPath: modal.keyPath || "",
        targetHost: modal.targetHost,
        targetPort: Number(modal.targetPort),
      });
      setModal(null);
      if (start) {
        if (modal.auth === "password") {
          await api.startTunnel(saved.id || modal.id || "", password);
        } else {
          await api.startTunnel(saved.id || modal.id || "");
        }
      }
      setPassword("");
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const shownLogs = logs.filter((l) => !logId || l.id === logId);

  return (
    <div className="page">
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>SSH 隧道管理</h1>
        <button className="btn primary" onClick={() => { setModal(empty()); setPassword(""); }}>+ 新建隧道</button>
      </div>
      {error && <div className="error">{error}</div>}
      {tunnels.map((t) => (
        <div className="card" key={t.id}>
          <div className="toolbar" style={{ marginBottom: 4 }}>
            <strong>{t.status === "running" ? "已连接" : "已停止"}  {t.alias}</strong>
            <span className="muted">{t.auth === "key" ? `私钥 (${t.keyPath || "未选"})` : "密码认证"}</span>
            {t.status === "running" && <span className="muted">已运行: {formatDur(t.uptimeSecs)}</span>}
            <button className="btn" onClick={() => toggle(t)}>{t.status === "running" ? "停止" : "启动"}</button>
            <button className="btn" onClick={() => setModal(t)}>编辑</button>
            <button className="btn danger" onClick={async () => { await api.deleteTunnel(t.id); reload(); }}>删除</button>
            <button className="btn" onClick={() => setLogId(t.id)}>查看日志</button>
          </div>
          <div className="path">
            路径: 本机 {t.localBind}:{t.localPort} ──&gt; [跳板: {t.username}@{t.jumpHost}:{t.jumpPort}] ──&gt; {t.targetHost}:{t.targetPort}
          </div>
        </div>
      ))}
      {tunnels.length === 0 && <div className="placeholder">还没有隧道。点击「新建隧道」开始，对应 ssh -NfL。</div>}

      <h1>实时连接日志 {logId ? tunnels.find((t) => t.id === logId)?.alias ?? "" : ""}</h1>
      <div className="log">
        {shownLogs.map((l, i) => (
          <div key={i}>[{formatTs(l.ts)}] [{l.level}] {l.message}</div>
        ))}
      </div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>新建 SSH 本地转发 (-L)</h2>
            <div className="form-grid">
              <span>隧道别名</span>
              <input value={modal.alias ?? ""} onChange={(e) => setModal({ ...modal, alias: e.target.value })} />
              <span>本地监听端口</span>
              <input type="number" value={modal.localPort ?? 0} onChange={(e) => setModal({ ...modal, localPort: Number(e.target.value) })} />
              <span>跳板机地址</span>
              <input value={modal.jumpHost ?? ""} onChange={(e) => setModal({ ...modal, jumpHost: e.target.value })} />
              <span>端口</span>
              <input type="number" value={modal.jumpPort ?? 22} onChange={(e) => setModal({ ...modal, jumpPort: Number(e.target.value) })} />
              <span>登录用户名</span>
              <input value={modal.username ?? ""} onChange={(e) => setModal({ ...modal, username: e.target.value })} />
              <span>认证方式</span>
              <div>
                <label><input type="radio" checked={modal.auth === "password"} onChange={() => setModal({ ...modal, auth: "password" })} /> 密码认证</label>
                {"  "}
                <label><input type="radio" checked={modal.auth === "key"} onChange={() => setModal({ ...modal, auth: "key" })} /> 私钥文件</label>
              </div>
              {modal.auth === "password" ? (
                <>
                  <span>密码</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不保存到磁盘" />
                </>
              ) : (
                <>
                  <span>私钥路径</span>
                  <input value={modal.keyPath ?? ""} onChange={(e) => setModal({ ...modal, keyPath: e.target.value })} />
                </>
              )}
              <span>目标主机 IP</span>
              <input value={modal.targetHost ?? ""} onChange={(e) => setModal({ ...modal, targetHost: e.target.value })} />
              <span>端口</span>
              <input type="number" value={modal.targetPort ?? 0} onChange={(e) => setModal({ ...modal, targetPort: Number(e.target.value) })} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>取消</button>
              <button className="btn" onClick={() => save(false)}>保存</button>
              <button className="btn primary" onClick={() => save(true)}>保存并启动</button>
            </div>
          </div>
        </div>
      )}

      {askPass && (
        <div className="modal-back" onClick={() => setAskPass(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>输入密码以启动 {askPass.alias}</h2>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="modal-actions">
              <button className="btn" onClick={() => setAskPass(null)}>取消</button>
              <button className="btn primary" onClick={async () => {
                try {
                  await api.startTunnel(askPass.id, password);
                  setAskPass(null);
                  setPassword("");
                  await reload();
                } catch (e) {
                  setError(String(e));
                }
              }}>启动</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDur(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatTs(ts: string) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n < 1e9) return ts;
  return new Date(n * 1000).toLocaleString();
}
