mod nic;
mod oui;
mod scanner;
mod ssh;
mod store;

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use store::SshTunnelConfig;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct TunnelRuntime {
    cancel: CancellationToken,
    started: Instant,
}

#[derive(Default)]
struct AppState {
    scan: Mutex<Option<CancellationToken>>,
    tunnels: Mutex<HashMap<String, TunnelRuntime>>,
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
    let cancel = take_scan_slot(&state)?;
    let task_id = Uuid::new_v4().to_string();
    let app2 = app.clone();
    let cancel2 = cancel.clone();
    let task2 = task_id.clone();
    tokio::spawn(async move {
        scanner::run_lan_scan(
            app2,
            task2,
            hosts,
            req.icmp,
            req.tcp_probe,
            req.timeout_ms,
            req.concurrency,
            cancel2,
        )
        .await;
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
    let cancel = take_scan_slot(&state)?;
    let task_id = Uuid::new_v4().to_string();
    let app2 = app.clone();
    let cancel2 = cancel.clone();
    let task2 = task_id.clone();
    tokio::spawn(async move {
        scanner::run_port_scan(app2, task2, ip, ports, req.timeout_ms, req.concurrency, cancel2)
            .await;
    });
    Ok(serde_json::json!({ "taskId": task_id }))
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) -> Result<(), String> {
    if let Some(token) = state.scan.lock().map_err(|e| e.to_string())?.take() {
        token.cancel();
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

fn take_scan_slot(state: &AppState) -> Result<CancellationToken, String> {
    let mut slot = state.scan.lock().map_err(|e| e.to_string())?;
    if slot.as_ref().is_some_and(|t| !t.is_cancelled()) {
        return Err("请先取消当前扫描".into());
    }
    let token = CancellationToken::new();
    *slot = Some(token.clone());
    Ok(token)
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
            delete_tunnel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
