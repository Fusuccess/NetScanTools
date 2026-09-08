import { useEffect, useState } from "react";
import { api, watchForwardStatus } from "../lib/tauri";
import type { Nic, PortMap } from "../lib/types";

type Draft = Partial<PortMap>;

function empty(): Draft {
  return {
    id: "",
    bindIp: "127.0.0.1",
    listenPort: 8080,
    targetHost: "",
    targetPort: 80,
  };
}

function bindLabel(ip: string, nics: Nic[]) {
  if (ip === "0.0.0.0") return "0.0.0.0 (全部网卡)";
  if (ip === "127.0.0.1") return "127.0.0.1 (回环)";
  const n = nics.find((x) => x.ipv4 === ip);
  return n ? `${n.name} (${n.ipv4})` : ip;
}

export default function PortForward({ nics }: { nics: Nic[] }) {
  const [rows, setRows] = useState<PortMap[]>([]);
  const [modal, setModal] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    setRows(await api.listForwards());
  }

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
    return watchForwardStatus((p) => {
      if (p.lastError) setError(p.lastError);
      reload().catch(() => {});
    });
  }, []);

  async function toggle(row: PortMap) {
    setError("");
    try {
      if (row.status === "running") await api.stopForward(row.id);
      else await api.startForward(row.id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function save(start: boolean) {
    if (!modal) return;
    setError("");
    try {
      const saved = await api.saveForward({
        id: modal.id || "",
        bindIp: modal.bindIp,
        listenPort: Number(modal.listenPort),
        targetHost: modal.targetHost,
        targetPort: Number(modal.targetPort),
      });
      setModal(null);
      if (start) await api.startForward(saved.id || modal.id || "");
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const lanNics = nics.filter((n) => !n.ipv4.startsWith("127."));

  return (
    <div className="page">
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>本机端口映射</h1>
        <button className="btn primary" onClick={() => setModal(empty())}>+ 新建映射</button>
      </div>
      <p className="muted">把本机某个 IP:端口上的 TCP 连接转到目标，不经过 SSH、不加密。和 SSH 隧道不是一回事。</p>
      {error && <div className="error">{error}</div>}
      <table className="data">
        <thead>
          <tr>
            <th>入口绑定网卡</th>
            <th>入口端口</th>
            <th>目标地址</th>
            <th>目标端口</th>
            <th>连接数</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="placeholder" colSpan={7}>还没有映射。点击「新建映射」开始。</td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{bindLabel(r.bindIp, nics)}</td>
              <td>{r.listenPort}</td>
              <td>{r.targetHost}</td>
              <td>{r.targetPort}</td>
              <td>{r.connections}</td>
              <td className={r.status === "running" ? "dot" : "dot off"}>
                {r.status === "running" ? "运行" : r.status === "error" ? "出错" : "停止"}
                {r.lastError ? ` (${r.lastError})` : ""}
              </td>
              <td>
                <button className="btn" onClick={() => void toggle(r)}>{r.status === "running" ? "停止" : "启动"}</button>
                {" "}
                <button className="btn" disabled={r.status === "running"} onClick={() => setModal(r)}>编辑</button>
                {" "}
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!window.confirm("确定删除这条映射？")) return;
                    try {
                      await api.deleteForward(r.id);
                      await reload();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{modal.id ? "编辑映射" : "新建映射"}</h2>
            <div className="form-grid">
              <span>入口绑定</span>
              <select
                value={modal.bindIp ?? "127.0.0.1"}
                onChange={(e) => setModal({ ...modal, bindIp: e.target.value })}
              >
                <option value="127.0.0.1">127.0.0.1 (回环)</option>
                <option value="0.0.0.0">0.0.0.0 (全部网卡)</option>
                {lanNics.map((n) => (
                  <option key={`${n.name}|${n.ipv4}`} value={n.ipv4}>
                    {n.name} ({n.ipv4})
                  </option>
                ))}
              </select>
              <span>入口端口</span>
              <input type="number" value={modal.listenPort ?? 0} onChange={(e) => setModal({ ...modal, listenPort: Number(e.target.value) })} />
              <span>目标地址</span>
              <input value={modal.targetHost ?? ""} onChange={(e) => setModal({ ...modal, targetHost: e.target.value })} />
              <span>目标端口</span>
              <input type="number" value={modal.targetPort ?? 0} onChange={(e) => setModal({ ...modal, targetPort: Number(e.target.value) })} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>取消</button>
              <button className="btn" onClick={() => void save(false)}>保存</button>
              <button className="btn primary" onClick={() => void save(true)}>保存并启动</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
