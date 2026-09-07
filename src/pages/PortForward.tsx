export default function PortForward() {
  return (
    <div className="page">
      <div className="toolbar">
        <h1 style={{ margin: 0, flex: 1 }}>本机端口映射</h1>
        <button className="btn" disabled>+ 新建映射</button>
      </div>
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
      </table>
      <div className="placeholder">
        四期功能：选择本机入口 IP 和端口，转发到目标 IP 和端口（不经过 SSH）。
        一期仅保留页面位置。
      </div>
    </div>
  );
}
