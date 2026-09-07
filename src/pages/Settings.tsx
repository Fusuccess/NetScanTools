import { useState } from "react";
import { COMMON_PORTS, type Settings } from "../lib/types";

export default function SettingsPage({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
}) {
  const [form, setForm] = useState(settings);
  const [msg, setMsg] = useState("");

  return (
    <div className="page">
      <h1>设置</h1>
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="form-grid">
          <span>默认超时 (ms)</span>
          <input type="number" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} />
          <span>默认并发</span>
          <input type="number" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} />
          <span>常用端口</span>
          <input
            value={form.commonPorts.join(",")}
            onChange={(e) =>
              setForm({
                ...form,
                commonPorts: e.target.value
                  .split(",")
                  .map((s) => Number(s.trim()))
                  .filter((n) => n > 0 && n <= 65535),
              })
            }
            placeholder={COMMON_PORTS}
          />
          <span>默认 ICMP</span>
          <label><input type="checkbox" checked={form.defaultIcmp} onChange={(e) => setForm({ ...form, defaultIcmp: e.target.checked })} /> 勾选</label>
          <span>默认 TCP 探活</span>
          <label><input type="checkbox" checked={form.defaultTcp} onChange={(e) => setForm({ ...form, defaultTcp: e.target.checked })} /> 勾选</label>
        </div>
        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={async () => {
              await onSave(form);
              setMsg("已保存");
            }}
          >
            保存
          </button>
        </div>
        {msg && <div className="muted">{msg}</div>}
      </div>
    </div>
  );
}
