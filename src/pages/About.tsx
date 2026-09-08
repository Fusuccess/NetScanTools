import { api } from "../lib/tauri";

export default function About() {
  return (
    <div className="page">
      <h1>关于</h1>
      <div className="card about-card">
        <h3>NetScanTools</h3>
        <p>版本 0.1.0</p>
        <p>作者：符元学</p>
        <p>
          更多开源产品：{" "}
          <button type="button" className="link" onClick={() => void api.openAuthorSite()}>
            https://fusuccess.top
          </button>
        </p>
      </div>
      <div className="card about-card disclaimer">
        <h3>免责声明</h3>
        <p>
          本软件仅供个人学习、网络运维，以及在已获授权的网络中进行检测。请只扫描自己有权限的目标。
        </p>
        <p>
          切勿将本软件用于网络攻击、未经授权的扫描、入侵、窃取数据，或其他任何违法违规行为。
        </p>
        <p>
          因使用或滥用本软件造成的后果，由使用者自行承担。作者不承担任何法律责任。
        </p>
      </div>
    </div>
  );
}
