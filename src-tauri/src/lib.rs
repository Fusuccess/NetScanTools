mod nic;
mod oui;
mod scanner;
mod ssh;
mod store;
mod forward;

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;
use store::{ForwardConfig, SshTunnelConfig};
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct TunnelRuntime {
    cancel: CancellationToken,
    started: Instant,
}

struct ScanSlot {
    id: String,
    cancel: CancellationToken,
}

struct ForwardRuntime {
    cancel: CancellationToken,
    connections: Arc<AtomicUsize>,
}

#[derive(Default)]
struct AppState {
    scan: Mutex<Option<ScanSlot>>,
    tunnels: Mutex<HashMap<String, TunnelRuntime>>,
    forwards: Mutex<HashMap<String, ForwardRuntime>>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn list_nics() -> Result<Vec<nic::Nic>, String> {
    nic::list_nics()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<store::Settings, String> {
    Ok(store::load_settings(&data_dir(&app)?))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: store::Settings) -> Result<store::Settings, String> {
    let dir = data_dir(&app)?;
    store::save_settings(&dir, &settings)?;
    Ok(settings)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanScanRequest {
    range: String,
    icmp: bool,
    tcp_probe: bool,
    timeout_ms: u64,
    concurrency: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortScanRequest {
    ip: String,
    ports: String,
    timeout_ms: u64,
    concurrency: u32,
}

#[tauri::command]
async fn start_lan_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    req: LanScanRequest,
) -> Result<serde_json::Value, String> {
    if !req.icmp && !req.tcp_probe {
        return Err("请至少勾选 ICMP 或 TCP 探测".into());
    }
    let hosts = scanner::parse_range(&req.range)?;
    let task_id = Uuid::new_v4().to_string();
    let cancel = take_scan_slot(&state, &task_id)?;
    let app2 = app.clone();
    let app3 = app.clone();
    let cancel2 = cancel.clone();
    let task2 = task_id.clone();
    tokio::spawn(async move {
        scanner::run_lan_scan(
            app2,
            task2.clone(),
            hosts,
            req.icmp,
            req.tcp_probe,
            req.timeout_ms,
            req.concurrency,
            cancel2,
        )
        .await;
        release_scan_slot(&app3, &task2);
    });
    Ok(serde_json::json!({ "taskId": task_id }))
}

#[tauri::command]
async fn start_port_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    req: PortScanRequest,
) -> Result<serde_json::Value, String> {
    let ip = req.ip.parse().map_err(|_| "目标 IP 无效".to_string())?;
    let ports = scanner::parse_ports(&req.ports)?;
    let task_id = Uuid::new_v4().to_string();
    let cancel = take_scan_slot(&state, &task_id)?;
    let app2 = app.clone();
    let app3 = app.clone();
    let cancel2 = cancel.clone();
    let task2 = task_id.clone();
    tokio::spawn(async move {
        scanner::run_port_scan(app2, task2.clone(), ip, ports, req.timeout_ms, req.concurrency, cancel2)
            .await;
        release_scan_slot(&app3, &task2);
    });
    Ok(serde_json::json!({ "taskId": task_id }))
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) -> Result<(), String> {
    if let Some(slot) = state.scan.lock().map_err(|e| e.to_string())?.take() {
        slot.cancel.cancel();
    }
    Ok(())
}

#[tauri::command]
fn list_tunnels(app: AppHandle, state: State<AppState>) -> Result<Vec<ssh::SshTunnelView>, String> {
    views(&app, &state)
}

#[tauri::command]
fn save_tunnel(app: AppHandle, mut config: SshTunnelConfig) -> Result<SshTunnelConfig, String> {
    if config.alias.trim().is_empty() {
        return Err("请填写隧道别名".into());
    }
    if config.local_bind.is_empty() {
        config.local_bind = "127.0.0.1".into();
    }
    if config.id.is_empty() {
        config.id = Uuid::new_v4().to_string();
    }
    let dir = data_dir(&app)?;
    let mut tunnels = store::load_tunnels(&dir);
    if let Some(existing) = tunnels.iter_mut().find(|t| t.id == config.id) {
        *existing = config.clone();
    } else {
        tunnels.push(config.clone());
    }
    store::save_tunnels(&dir, &tunnels)?;
    Ok(config)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArg {
    id: String,
    password: Option<String>,
}

#[tauri::command]
async fn start_tunnel(
    app: AppHandle,
    state: State<'_, AppState>,
    arg: IdArg,
) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let cfg = store::load_tunnels(&dir)
        .into_iter()
        .find(|t| t.id == arg.id)
        .ok_or_else(|| "找不到隧道配置".to_string())?;
    {
        let mut map = state.tunnels.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&cfg.id) {
            return Err("隧道已在运行".into());
        }
        let cancel = CancellationToken::new();
        map.insert(
            cfg.id.clone(),
            TunnelRuntime {
                cancel: cancel.clone(),
                started: Instant::now(),
            },
        );
        let app2 = app.clone();
        let dir2 = dir.clone();
        let id = cfg.id.clone();
        tokio::spawn(async move {
            ssh::run_tunnel(app2.clone(), dir2, cfg, arg.password, cancel).await;
            if let Some(state) = app2.try_state::<AppState>() {
                if let Ok(mut map) = state.tunnels.lock() {
                    map.remove(&id);
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
fn stop_tunnel(app: AppHandle, state: State<AppState>, arg: IdArg) -> Result<(), String> {
    if let Some(rt) = state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&arg.id)
    {
        rt.cancel.cancel();
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
fn delete_tunnel(app: AppHandle, state: State<AppState>, arg: IdArg) -> Result<(), String> {
    if state
        .tunnels
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&arg.id)
    {
        return Err("请先停止隧道再删除".into());
    }
    let dir = data_dir(&app)?;
    let tunnels: Vec<_> = store::load_tunnels(&dir)
        .into_iter()
        .filter(|t| t.id != arg.id)
        .collect();
    store::save_tunnels(&dir, &tunnels)
}

#[tauri::command]
fn list_forwards(app: AppHandle, state: State<AppState>) -> Result<Vec<forward::ForwardView>, String> {
    forward_views(&app, &state)
}

#[tauri::command]
fn save_forward(app: AppHandle, mut config: ForwardConfig) -> Result<ForwardConfig, String> {
    if config.bind_ip.trim().is_empty() {
        return Err("请选择入口绑定地址".into());
    }
    if config.listen_port == 0 {
        return Err("入口端口无效".into());
    }
    if config.target_host.trim().is_empty() {
        return Err("请填写目标地址".into());
    }
    if config.target_port == 0 {
        return Err("目标端口无效".into());
    }
    if config.id.is_empty() {
        config.id = Uuid::new_v4().to_string();
    }
    let dir = data_dir(&app)?;
    let mut list = store::load_forwards(&dir);
    if let Some(existing) = list.iter_mut().find(|t| t.id == config.id) {
        *existing = config.clone();
    } else {
        list.push(config.clone());
    }
    store::save_forwards(&dir, &list)?;
    Ok(config)
}

#[tauri::command]
async fn start_forward(
    app: AppHandle,
    state: State<'_, AppState>,
    arg: IdArg,
) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let cfg = store::load_forwards(&dir)
        .into_iter()
        .find(|t| t.id == arg.id)
        .ok_or_else(|| "找不到映射配置".to_string())?;
    {
        let mut map = state.forwards.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&cfg.id) {
            return Err("映射已在运行".into());
        }
        let cancel = CancellationToken::new();
        let connections = Arc::new(AtomicUsize::new(0));
        map.insert(
            cfg.id.clone(),
            ForwardRuntime {
                cancel: cancel.clone(),
                connections: connections.clone(),
            },
        );
        let app2 = app.clone();
        let id = cfg.id.clone();
        tokio::spawn(async move {
            forward::run_forward(app2.clone(), cfg, connections, cancel).await;
            if let Some(state) = app2.try_state::<AppState>() {
                if let Ok(mut map) = state.forwards.lock() {
                    map.remove(&id);
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
fn stop_forward(state: State<AppState>, arg: IdArg) -> Result<(), String> {
    if let Some(rt) = state
        .forwards
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&arg.id)
    {
        rt.cancel.cancel();
    }
    Ok(())
}

#[tauri::command]
fn delete_forward(app: AppHandle, state: State<AppState>, arg: IdArg) -> Result<(), String> {
    if state
        .forwards
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&arg.id)
    {
        return Err("请先停止映射再删除".into());
    }
    let dir = data_dir(&app)?;
    let list: Vec<_> = store::load_forwards(&dir)
        .into_iter()
        .filter(|t| t.id != arg.id)
        .collect();
    store::save_forwards(&dir, &list)
}

fn take_scan_slot(state: &AppState, task_id: &str) -> Result<CancellationToken, String> {
    let mut slot = state.scan.lock().map_err(|e| e.to_string())?;
    if slot.as_ref().is_some_and(|s| !s.cancel.is_cancelled()) {
        return Err("请先取消当前扫描".into());
    }
    let token = CancellationToken::new();
    *slot = Some(ScanSlot {
        id: task_id.to_string(),
        cancel: token.clone(),
    });
    Ok(token)
}

fn release_scan_slot(app: &AppHandle, task_id: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut slot) = state.scan.lock() {
            if slot.as_ref().is_some_and(|s| s.id == task_id) {
                *slot = None;
            }
        }
    }
}

fn views(app: &AppHandle, state: &AppState) -> Result<Vec<ssh::SshTunnelView>, String> {
    let dir = data_dir(app)?;
    let running = state.tunnels.lock().map_err(|e| e.to_string())?;
    Ok(store::load_tunnels(&dir)
        .into_iter()
        .map(|config| {
            let rt = running.get(&config.id);
            ssh::SshTunnelView {
                status: if rt.is_some() {
                    "running".into()
                } else {
                    "stopped".into()
                },
                uptime_secs: rt.map(|r| r.started.elapsed().as_secs()).unwrap_or(0),
                last_error: None,
                config,
            }
        })
        .collect())
}

fn forward_views(app: &AppHandle, state: &AppState) -> Result<Vec<forward::ForwardView>, String> {
    let dir = data_dir(app)?;
    let running = state.forwards.lock().map_err(|e| e.to_string())?;
    Ok(store::load_forwards(&dir)
        .into_iter()
        .map(|config| {
            let rt = running.get(&config.id);
            forward::ForwardView {
                status: if rt.is_some() {
                    "running".into()
                } else {
                    "stopped".into()
                },
                connections: rt
                    .map(|r| r.connections.load(Ordering::Relaxed) as u32)
                    .unwrap_or(0),
                last_error: None,
                config,
            }
        })
        .collect())
}

#[tauri::command]
fn open_author_site() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("https://fusuccess.top")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "https://fusuccess.top"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_nics,
            get_settings,
            save_settings,
            start_lan_scan,
            start_port_scan,
            cancel_scan,
            list_tunnels,
            save_tunnel,
            start_tunnel,
            stop_tunnel,
            delete_tunnel,
            list_forwards,
            save_forward,
            start_forward,
            stop_forward,
            delete_forward,
            open_author_site
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
