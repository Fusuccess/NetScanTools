# NetScanTools

本机图形化网络工具，技术栈为 **Tauri 2 + React + Rust**，可打包为 macOS 与 Windows 桌面应用。

面向个人和运维自用：扫描自己有权限的网络，发现局域网设备、探测指定 IP 的端口、经跳板建立 SSH 本地转发。不做 Linux 安装包，不捆绑 nmap，不采用 Electron 或 Flutter。

界面以 [`NetScanTools_UI_Prototype.md`](NetScanTools_UI_Prototype.md) 为准，实现以 [`开发设计书.md`](开发设计书.md) 为准；与代码不一致时以代码为准。

**请只在自己有权限的网络上使用。**

## 功能

四个入口共用同一个桌面壳。一期已实现前三项；本机端口映射仍是占位页。

### 局域网扫描

手动指定网段，列出在线设备。支持 CIDR（如 `192.168.1.0/24`）或起止 IP。可看进度、可中途取消。

在线判断固定用 ICMP Ping。关 ICMP 的设备不会出现在列表里；端口开没开请用「端口扫描」。

同网段在 ping 通后再读本机 ARP 表拿 MAC，并用 MAC 前缀对照厂商库。主机名按顺序尝试：反向 DNS → ARP 缓存里的名字 → 局域网组播 DNS（mDNS，如 `.local`）。很多摄像头、电视仍可能没有名字。

换网络后点「刷新网卡」，顶栏 IP 和扫描网段会跟上当前网卡。结果表可点 IP / MAC 复制，也可「复制结果」。

### 端口扫描

对单个 IP 做 TCP 全连接探测，不限局域网。预设：常用端口、`1–1024`、`1–65535`，或自定义。

结果区分开放、关闭、超时，三种状态都会进表，可按状态筛选（默认看开放）。关闭是对端拒绝连接；防火墙丢包通常记为超时。开放端口会读前若干字节作横幅：SSH、HTTP 等文本协议直接显示；MySQL 等二进制握手只抽出可读 ASCII（例如版本号）。扫描 `1–65535` 时行数很多，页面可能较慢。

### SSH 隧道

对应：

```bash
ssh -NfL 9999:192.168.100.50:8080 root@jump.example.com -p 2222
```

图形表单填写本地端口、目标主机与端口、跳板地址/端口/用户。认证支持密码和私钥。自己实现 SSH 协议，不调用系统 `ssh`。一期只做本地转发（`-L`），可多条、可启停；密码不写进磁盘。

### 本机端口映射（尚未实现）

计划：在本机选定网卡 IP 上监听入口端口，转到目标 IP 和端口，不经过 SSH。一期仅保留页面位置。

## 环境要求

- [Node.js](https://nodejs.org/)（建议当前 LTS）
- [Rust](https://rustup.rs/)（`rustup` 默认工具链）
- **macOS：** Xcode 命令行工具（`xcode-select --install`）
- **Windows：** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」

## 开发

```bash
npm install
npm run tauri dev
```

## 打包

配置里会打出 macOS `.dmg` 和 Windows NSIS 安装程序（`*-setup.exe`）。**在哪个系统上打包，就打哪个系统的安装包**；macOS 不能直接打出可靠的 Windows 安装包（交叉编译仅作备选）。

先安装依赖：

```bash
npm install
```

### macOS（Apple Silicon / M 芯片）

```bash
npm run tauri build -- --target aarch64-apple-darwin
```

产物：`src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`

### macOS（Intel）

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin
```

产物：`src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/`

### macOS（一个包同时支持 Intel 和 M 芯片）

体积大约是单架构的两倍：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

产物：`src-tauri/target/universal-apple-darwin/release/bundle/dmg/`

### Windows

在 Windows 上：

```bash
npm run tauri build
```

产物：`src-tauri/target/release/bundle/nsis/`

没有 Windows 机器时，可在 macOS 上交叉编译 NSIS 包（官方当备选，不能签名）：

```bash
brew install nsis llvm
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc
```

产物：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`

发给别人之前：macOS 未公证会提示无法验证开发者，需要 Apple 开发者账号做签名和公证。Windows 未签名时 SmartScreen / 杀毒软件可能拦截。

## 技术栈

| 层 | 技术 | 职责 |
|----|------|------|
| 界面 | Tauri 2 + React | 功能页、进度、结果表、表单 |
| 本机 | Rust（`src-tauri`） | 主机发现、端口探测、SSH 隧道、本地存储 |
| 通信 | Tauri IPC | 界面发「开始 / 取消」，Rust 推送进度和结果 |
| 打包 | Tauri 2 | macOS `.dmg` / `.app`，Windows NSIS `setup.exe` |

```
src/                 React 界面
src-tauri/           Rust 本机层
  src/
    lib.rs           Tauri 入口与 IPC 注册
    scanner.rs       局域网扫描、端口扫描、主机名
    ssh.rs           SSH 本地转发
    nic.rs           网卡列表
    store.rs         设置与隧道配置
```

不把 nmap 打进安装包。SSH 不调用系统 `ssh`。密码不落盘。

## 设备信息能拿到什么

| 信息 | 典型来源 | 说明 |
|------|----------|------|
| 是否在线 | ICMP Ping | 关 ping 的设备会漏 |
| IP / 主机名 | 反向 DNS、ARP 名称、mDNS | 看设备是否报名字 |
| MAC / 网卡厂商 | 同网段 ARP + 厂商库 | 跨网段没有 MAC |
| 开放端口与服务横幅 | TCP 连接 + 可读 ASCII | 全连接，不需要管理员权限 |

跨网段拿不到 MAC。IPv6 不做。UPnP / SNMP 型号、扫描导出、钥匙串存密码等见后续计划。

## 后续计划

- 二期：UPnP / SNMP 等型号信息、扫描历史与导出、系统钥匙串存密码
- 三期：SSH `-R` / `-D`、断线重连
- 四期：本机端口映射（入口 IP:端口转到目标，不经过 SSH）

## 系统说明

- **macOS：** 不要开 App Store 沙盒，否则局域网探测会被挡住。监听 1024 以下端口通常需要提权。
- **Windows：** 首次运行可能弹出防火墙询问。部分杀毒软件会把端口扫描报成风险软件。
- 工具有并发上限，扫描可取消，避免把网扫死。

## 作者

符元学 · [更多开源产品](https://fusuccess.top)

## 免责声明

本软件仅供个人学习、网络运维，以及在已获授权的网络中进行检测。切勿用于网络攻击、未经授权的扫描、入侵、窃取数据或其他违法违规行为。因使用或滥用造成的后果由使用者自行承担，作者不承担法律责任。
