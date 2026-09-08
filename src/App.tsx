import { useEffect, useState } from "react";
import "./App.css";
import { api } from "./lib/tauri";
import type { Nic, Settings } from "./lib/types";
import LanScan from "./pages/LanScan";
import PortScan from "./pages/PortScan";
import SshTunnels from "./pages/SshTunnels";
import PortForward from "./pages/PortForward";
import SettingsPage from "./pages/Settings";

type Page = "lan" | "port" | "ssh" | "fwd" | "settings";

export default function App() {
  const [page, setPage] = useState<Page>("lan");
  const [nics, setNics] = useState<Nic[]>([]);
  const [nic, setNic] = useState<Nic | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState("就绪");
  const [scanning, setScanning] = useState(false);
  const [tunnelCount, setTunnelCount] = useState(0);
  const [portTarget, setPortTarget] = useState("");
  const [nicsBusy, setNicsBusy] = useState(false);

  function pickNic(list: Nic[], cur: Nic | null) {
    if (cur) {
      const same = list.find((n) => n.name === cur.name && n.ipv4 === cur.ipv4);
      if (same) return same;
      const byName = list.find((n) => n.name === cur.name && !n.ipv4.startsWith("127."));
      if (byName) return byName;
    }
    return list.find((n) => !n.ipv4.startsWith("127.")) ?? list[0] ?? null;
  }

  async function refreshNics() {
    setNicsBusy(true);
    try {
      const list = await api.listNics();
      setNics(list);
      setNic((cur) => pickNic(list, cur));
    } catch {
      // keep current list
    } finally {
      setNicsBusy(false);
    }
  }

  useEffect(() => {
    void refreshNics();
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  useEffect(() => {
    if (scanning) setStatus("扫描中");
    else if (tunnelCount > 0) setStatus(`隧道运行中 (${tunnelCount})`);
    else setStatus("就绪");
  }, [scanning, tunnelCount]);

  async function saveSettings(next: Settings) {
    const saved = await api.saveSettings(next);
    setSettings(saved);
  }

  const nav = (id: Page, label: string) => (
    <button className={`nav-btn ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
      {label}
    </button>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">NetScanTools</div>
        <div className="top-meta">
          <span>
            {nic ? `${nic.name}: ${nic.ipv4}` : "无网卡"}
          </span>
          <button className="btn" disabled={nicsBusy} onClick={() => void refreshNics()}>
            {nicsBusy ? "刷新中" : "刷新网卡"}
          </button>
          <span>状态: {status}</span>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar">
          {nav("lan", "局域网扫描")}
          {nav("port", "端口扫描")}
          {nav("ssh", "SSH 隧道")}
          {nav("fwd", "端口映射")}
          <div className="spacer" />
          <div className="side-sep" />
          {nav("settings", "设置")}
          <button
            className="nav-btn"
            onClick={() => settings && saveSettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}
          >
            {settings?.theme === "dark" ? "浅色模式" : "暗黑模式"}
          </button>
        </aside>
        <main className="main">
          {page === "lan" && settings && (
            <LanScan
              nics={nics}
              nic={nic}
              onNic={setNic}
              onRefreshNics={refreshNics}
              nicsBusy={nicsBusy}
              settings={settings}
              scanning={scanning}
              setScanning={setScanning}
              onJumpPort={(ip) => {
                setPortTarget(ip);
                setPage("port");
              }}
            />
          )}
          {page === "port" && settings && (
            <PortScan
              settings={settings}
              target={portTarget}
              scanning={scanning}
              setScanning={setScanning}
            />
          )}
          {page === "ssh" && <SshTunnels onRunningCount={setTunnelCount} />}
          {page === "fwd" && <PortForward />}
          {page === "settings" && settings && (
            <SettingsPage settings={settings} onSave={saveSettings} />
          )}
        </main>
      </div>
    </div>
  );
}
