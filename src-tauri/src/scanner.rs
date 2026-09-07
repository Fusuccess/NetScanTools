use crate::oui;
use ipnetwork::Ipv4Network;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream as TokioTcp;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const PROBE_PORTS: [u16; 5] = [22, 80, 443, 445, 3389];

#[derive(Clone, Debug)]
struct ArpEntry {
    mac: String,
    kind: String,
    name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbePort {
    pub port: u16,
    pub banner: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRow {
    pub ip: String,
    pub hostname: Option<String>,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub rtt_ms: Option<u32>,
    pub arp_kind: Option<String>,
    pub probe_ports: Vec<ProbePort>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRow {
    pub port: u16,
    pub proto: String,
    pub state: String,
    pub service: String,
    pub banner: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    task_id: String,
    done: usize,
    total: usize,
    open: usize,
    closed: usize,
    timeout: usize,
}

pub fn parse_range(range: &str) -> Result<Vec<Ipv4Addr>, String> {
    let range = range.trim();
    if let Some((a, b)) = range.split_once('-') {
        let start: Ipv4Addr = a.trim().parse().map_err(|_| "起始 IP 无效".to_string())?;
        let end: Ipv4Addr = b.trim().parse().map_err(|_| "结束 IP 无效".to_string())?;
        let s = u32::from(start);
        let e = u32::from(end);
        if e < s {
            return Err("结束 IP 不能小于起始 IP".into());
        }
        if e - s > 65_536 {
            return Err("范围过大".into());
        }
        return Ok((s..=e).map(Ipv4Addr::from).collect());
    }
    let net: Ipv4Network = range.parse().map_err(|_| "网段格式无效，请用 CIDR 或起止 IP".to_string())?;
    let mut hosts: Vec<Ipv4Addr> = net.iter().collect();
    if net.prefix() < 31 && hosts.len() >= 2 {
        hosts.remove(0);
        hosts.pop();
    }
    Ok(hosts)
}

pub fn parse_ports(spec: &str) -> Result<Vec<u16>, String> {
    let mut ports = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            let start: u16 = a.trim().parse().map_err(|_| format!("无效端口 {part}"))?;
            let end: u16 = b.trim().parse().map_err(|_| format!("无效端口 {part}"))?;
            if end < start {
                return Err(format!("端口范围无效 {part}"));
            }
            for p in start..=end {
                ports.push(p);
            }
        } else {
            ports.push(part.parse().map_err(|_| format!("无效端口 {part}"))?);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err("端口列表为空".into());
    }
    Ok(ports)
}

pub async fn run_lan_scan(
    app: AppHandle,
    task_id: String,
    hosts: Vec<Ipv4Addr>,
    icmp: bool,
    tcp_probe: bool,
    timeout_ms: u64,
    concurrency: u32,
    cancel: CancellationToken,
) {
    let arp = tokio::task::spawn_blocking(load_arp_table).await.unwrap_or_default();
    let total = hosts.len();
    let done = Arc::new(AtomicUsize::new(0));
    let queue = Arc::new(Mutex::new(hosts.into_iter()));
    let timeout = Duration::from_millis(timeout_ms.max(50));
    let workers = concurrency.clamp(1, 256) as usize;
    let mut joins = Vec::new();

    for _ in 0..workers {
        let app = app.clone();
        let task_id = task_id.clone();
        let queue = queue.clone();
        let done = done.clone();
        let cancel = cancel.clone();
        let arp = arp.clone();
        joins.push(tokio::spawn(async move {
            loop {
                if cancel.is_cancelled() {
                    break;
                }
                let ip = queue.lock().await.next();
                let Some(ip) = ip else { break };
                if let Some(row) = probe_host(ip, icmp, tcp_probe, timeout, &arp).await {
                    let _ = app.emit("scan:host", &row);
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 4 == 0 || n == total {
                    let _ = app.emit(
                        "scan:progress",
                        ProgressPayload {
                            task_id: task_id.clone(),
                            done: n,
                            total,
                            open: 0,
                            closed: 0,
                            timeout: 0,
                        },
                    );
                }
            }
        }));
    }

    for j in joins {
        let _ = j.await;
    }
    let _ = app.emit(
        "scan:finished",
        serde_json::json!({ "taskId": task_id, "error": null }),
    );
}

pub async fn run_port_scan(
    app: AppHandle,
    task_id: String,
    ip: IpAddr,
    ports: Vec<u16>,
    timeout_ms: u64,
    concurrency: u32,
    cancel: CancellationToken,
) {
    let total = ports.len();
    let emit_closed = total <= 2048;
    let done = Arc::new(AtomicUsize::new(0));
    let open = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicUsize::new(0));
    let timed = Arc::new(AtomicUsize::new(0));
    let queue = Arc::new(Mutex::new(ports.into_iter()));
    let timeout = Duration::from_millis(timeout_ms.max(50));
    let workers = concurrency.clamp(1, 256) as usize;
    let mut joins = Vec::new();

    for _ in 0..workers {
        let app = app.clone();
        let task_id = task_id.clone();
        let queue = queue.clone();
        let done = done.clone();
        let open = open.clone();
        let closed = closed.clone();
        let timed = timed.clone();
        let cancel = cancel.clone();
        joins.push(tokio::spawn(async move {
            loop {
                if cancel.is_cancelled() {
                    break;
                }
                let port = queue.lock().await.next();
                let Some(port) = port else { break };
                let row = probe_port(ip, port, timeout).await;
                match row.state.as_str() {
                    "open" => {
                        open.fetch_add(1, Ordering::Relaxed);
                        let _ = app.emit("scan:port", &row);
                    }
                    "closed" => {
                        closed.fetch_add(1, Ordering::Relaxed);
                        if emit_closed {
                            let _ = app.emit("scan:port", &row);
                        }
                    }
                    _ => {
                        timed.fetch_add(1, Ordering::Relaxed);
                        if emit_closed {
                            let _ = app.emit("scan:port", &row);
                        }
                    }
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 8 == 0 || n == total {
                    let _ = app.emit(
                        "scan:progress",
                        ProgressPayload {
                            task_id: task_id.clone(),
                            done: n,
                            total,
                            open: open.load(Ordering::Relaxed),
                            closed: closed.load(Ordering::Relaxed),
                            timeout: timed.load(Ordering::Relaxed),
                        },
                    );
                }
            }
        }));
    }

    for j in joins {
        let _ = j.await;
    }
    let _ = app.emit(
        "scan:progress",
        ProgressPayload {
            task_id: task_id.clone(),
            done: total,
            total,
            open: open.load(Ordering::Relaxed),
            closed: closed.load(Ordering::Relaxed),
            timeout: timed.load(Ordering::Relaxed),
        },
    );
    let _ = app.emit(
        "scan:finished",
        serde_json::json!({ "taskId": task_id, "error": null }),
    );
}

async fn probe_host(
    ip: Ipv4Addr,
    icmp: bool,
    tcp_probe: bool,
    timeout: Duration,
    arp: &HashMap<String, ArpEntry>,
) -> Option<HostRow> {
    let started = Instant::now();
    let mut alive = false;
    let mut probe_ports = Vec::new();

    if icmp {
        alive = ping(ip, timeout).await;
    }
    if tcp_probe {
        for port in PROBE_PORTS {
            match tcp_state(IpAddr::V4(ip), port, timeout).await.as_str() {
                "open" => {
                    alive = true;
                    let banner = grab_banner(IpAddr::V4(ip), port, timeout).await.unwrap_or_default();
                    probe_ports.push(ProbePort { port, banner });
                }
                _ => {}
            }
        }
    }
    if !alive {
        return None;
    }

    let ip_s = ip.to_string();
    let cached = arp.get(&ip_s).cloned();
    let entry = tokio::task::spawn_blocking(move || lookup_one_arp(ip))
        .await
        .ok()
        .flatten()
        .or(cached);

    let (mac, arp_kind, arp_name) = match entry {
        Some(e) => (Some(e.mac), Some(e.kind), e.name),
        None => (None, None, None),
    };
    let vendor = mac.as_ref().map(|m| oui::lookup(m));
    let hostname = tokio::task::spawn_blocking(move || resolve_hostname(ip, arp_name))
        .await
        .ok()
        .flatten();

    Some(HostRow {
        ip: ip_s,
        hostname,
        mac,
        vendor,
        rtt_ms: Some(started.elapsed().as_millis() as u32),
        arp_kind,
        probe_ports,
    })
}

async fn probe_port(ip: IpAddr, port: u16, timeout: Duration) -> PortRow {
    let state = tcp_state(ip, port, timeout).await;
    let mut banner = String::new();
    if state == "open" {
        banner = grab_banner(ip, port, timeout).await.unwrap_or_default();
    }
    PortRow {
        port,
        proto: "TCP".into(),
        state,
        service: known_service(port).into(),
        banner,
    }
}

async fn tcp_state(ip: IpAddr, port: u16, timeout: Duration) -> String {
    let addr = SocketAddr::new(ip, port);
    match tokio::task::spawn_blocking(move || TcpStream::connect_timeout(&addr, timeout)).await {
        Ok(Ok(_)) => "open".into(),
        Ok(Err(e)) => {
            if e.kind() == std::io::ErrorKind::TimedOut {
                "timeout".into()
            } else {
                "closed".into()
            }
        }
        Err(_) => "timeout".into(),
    }
}

async fn grab_banner(ip: IpAddr, port: u16, timeout: Duration) -> Option<String> {
    let addr = SocketAddr::new(ip, port);
    let mut stream = tokio::time::timeout(timeout, TokioTcp::connect(addr))
        .await
        .ok()?
        .ok()?;
    if matches!(port, 80 | 8000 | 8080 | 8443 | 443) {
        let _ = tokio::time::timeout(
            timeout,
            stream.write_all(b"HEAD / HTTP/1.0\r\nHost: scan\r\n\r\n"),
        )
        .await;
    }
    let mut buf = [0u8; 256];
    let n = tokio::time::timeout(Duration::from_millis(400), stream.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    if n == 0 {
        return None;
    }
    Some(sanitize(&buf[..n]))
}

fn sanitize(bytes: &[u8]) -> String {
    let mut runs = Vec::new();
    let mut cur = String::new();
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            cur.push(b as char);
        } else if cur.len() >= 3 {
            runs.push(std::mem::take(&mut cur));
        } else {
            cur.clear();
        }
    }
    if cur.len() >= 3 {
        runs.push(cur);
    }
    runs.join(" ").chars().take(180).collect()
}

async fn ping(ip: Ipv4Addr, timeout: Duration) -> bool {
    let ip = ip.to_string();
    let wait = timeout.as_millis().max(50) as u64;
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("ping");
        #[cfg(windows)]
        cmd.args(["-n", "1", "-w", &wait.to_string(), &ip]);
        #[cfg(unix)]
        cmd.args(["-c", "1", "-W", &wait.to_string(), &ip]);
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

fn load_arp_table() -> HashMap<String, ArpEntry> {
    let output = Command::new("arp").arg("-a").output();
    let Ok(output) = output else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some((ip, entry)) = parse_arp_line(line) {
            map.insert(ip, entry);
        }
    }
    map
}

fn lookup_one_arp(ip: Ipv4Addr) -> Option<ArpEntry> {
    let ip_s = ip.to_string();
    let output = {
        #[cfg(windows)]
        {
            Command::new("arp").args(["-a", &ip_s]).output()
        }
        #[cfg(unix)]
        {
            Command::new("arp").arg(&ip_s).output()
        }
    }
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some((found, entry)) = parse_arp_line(line) {
            if found == ip_s {
                return Some(entry);
            }
        }
    }
    None
}

fn parse_arp_line(line: &str) -> Option<(String, ArpEntry)> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("incomplete") {
        return None;
    }
    let ip = line
        .split(['(', ')', ' '])
        .find(|s| s.parse::<Ipv4Addr>().is_ok())?
        .to_string();
    let mac = line
        .split_whitespace()
        .find(|s| s.contains(':') || s.contains('-'))
        .filter(|s| s.len() >= 11)?;
    let mac = mac.replace('-', ":").to_ascii_uppercase();
    if mac.chars().filter(|c| *c == ':').count() != 5 {
        return None;
    }
    let kind = if lower.contains("static") {
        "static"
    } else {
        "dynamic"
    };
    let name = line.find('(').and_then(|idx| {
        let prefix = line[..idx].trim();
        clean_hostname(prefix, &ip)
    });
    Some((
        ip,
        ArpEntry {
            mac,
            kind: kind.into(),
            name,
        },
    ))
}

fn resolve_hostname(ip: Ipv4Addr, arp_name: Option<String>) -> Option<String> {
    reverse_dns(ip)
        .or(arp_name)
        .or_else(|| mdns_ptr(ip))
}

fn reverse_dns(ip: Ipv4Addr) -> Option<String> {
    let name = dns_lookup::lookup_addr(&IpAddr::V4(ip)).ok()?;
    clean_hostname(&name, &ip.to_string())
}

fn clean_hostname(raw: &str, ip: &str) -> Option<String> {
    let name = raw.trim().trim_end_matches('.').to_string();
    if name.is_empty() || name == "?" || name == ip {
        None
    } else {
        Some(name)
    }
}

fn mdns_ptr(ip: Ipv4Addr) -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
    let _ = sock.set_multicast_ttl_v4(1);
    let pkt = encode_ptr_query(ip);
    sock.send_to(&pkt, "224.0.0.251:5353").ok()?;
    let mut buf = [0u8; 1500];
    let (n, _) = sock.recv_from(&mut buf).ok()?;
    parse_ptr_answer(&buf[..n]).and_then(|n| clean_hostname(&n, &ip.to_string()))
}

fn encode_ptr_query(ip: Ipv4Addr) -> Vec<u8> {
    let o = ip.octets();
    let qname = format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0]);
    let mut pkt = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in qname.split('.') {
        pkt.push(label.len() as u8);
        pkt.extend(label.as_bytes());
    }
    pkt.push(0);
    pkt.extend([0, 12, 0, 1]);
    pkt
}

fn parse_ptr_answer(msg: &[u8]) -> Option<String> {
    if msg.len() < 12 {
        return None;
    }
    let qd = u16::from_be_bytes([msg[4], msg[5]]) as usize;
    let an = u16::from_be_bytes([msg[6], msg[7]]) as usize;
    let mut i = 12usize;
    for _ in 0..qd {
        let (_, next) = read_name(msg, i)?;
        i = next.checked_add(4)?;
    }
    for _ in 0..an {
        let (_, next) = read_name(msg, i)?;
        i = next;
        if i + 10 > msg.len() {
            return None;
        }
        let rtype = u16::from_be_bytes([msg[i], msg[i + 1]]);
        let rdlen = u16::from_be_bytes([msg[i + 8], msg[i + 9]]) as usize;
        i += 10;
        if rtype == 12 {
            let (name, _) = read_name(msg, i)?;
            return Some(name);
        }
        i = i.checked_add(rdlen)?;
    }
    None
}

fn read_name(msg: &[u8], mut i: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut jumped = false;
    let mut end = i;
    let mut hops = 0;
    loop {
        if hops > 16 {
            return None;
        }
        let len = *msg.get(i)? as usize;
        if len == 0 {
            i += 1;
            if !jumped {
                end = i;
            }
            break;
        }
        if len & 0xC0 == 0xC0 {
            let ptr = ((len & 0x3F) << 8) | (*msg.get(i + 1)? as usize);
            if !jumped {
                end = i + 2;
            }
            i = ptr;
            jumped = true;
            hops += 1;
            continue;
        }
        if len & 0xC0 != 0 {
            return None;
        }
        i += 1;
        let label = std::str::from_utf8(msg.get(i..i + len)?).ok()?;
        labels.push(label.to_string());
        i += len;
        if !jumped {
            end = i;
        }
    }
    Some((labels.join("."), end))
}

fn known_service(port: u16) -> &'static str {
    match port {
        21 => "FTP",
        22 => "SSH",
        23 => "Telnet",
        25 => "SMTP",
        53 => "DNS",
        80 => "HTTP",
        110 => "POP3",
        139 => "NetBIOS",
        143 => "IMAP",
        443 => "HTTPS",
        445 => "SMB",
        3306 => "MySQL",
        3389 => "RDP",
        5432 => "PostgreSQL",
        5900 => "VNC",
        6379 => "Redis",
        8080 => "HTTP-Alt",
        8443 => "HTTPS-Alt",
        _ => "",
    }
}
