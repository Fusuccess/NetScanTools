use crate::store::ForwardConfig;
use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    #[serde(flatten)]
    pub config: ForwardConfig,
    pub status: String,
    pub connections: u32,
    pub last_error: Option<String>,
}

pub async fn run_forward(
    app: AppHandle,
    cfg: ForwardConfig,
    connections: Arc<AtomicUsize>,
    cancel: CancellationToken,
) {
    let id = cfg.id.clone();
    if let Err(err) = run_forward_inner(app.clone(), cfg, connections, cancel).await {
        let _ = app.emit(
            "forward:status",
            serde_json::json!({ "id": id, "status": "error", "lastError": err }),
        );
    }
}

async fn run_forward_inner(
    app: AppHandle,
    cfg: ForwardConfig,
    connections: Arc<AtomicUsize>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let bind = format!("{}:{}", cfg.bind_ip, cfg.listen_port);
    let listener = TcpListener::bind(&bind)
        .await
        .map_err(|e| format!("监听 {bind} 失败: {e}"))?;
    let _ = app.emit(
        "forward:status",
        serde_json::json!({ "id": cfg.id, "status": "running", "lastError": null }),
    );

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = app.emit(
                    "forward:status",
                    serde_json::json!({ "id": cfg.id, "status": "stopped" }),
                );
                break;
            }
            accepted = listener.accept() => {
                let (mut incoming, _) = accepted.map_err(|e| e.to_string())?;
                let target = format!("{}:{}", cfg.target_host, cfg.target_port);
                let app = app.clone();
                let id = cfg.id.clone();
                let connections = connections.clone();
                connections.fetch_add(1, Ordering::Relaxed);
                emit_conns(&app, &id, connections.load(Ordering::Relaxed));
                tokio::spawn(async move {
                    match TcpStream::connect(&target).await {
                        Ok(mut outgoing) => {
                            let _ = copy_bidirectional(&mut incoming, &mut outgoing).await;
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "forward:status",
                                serde_json::json!({
                                    "id": id,
                                    "status": "running",
                                    "lastError": format!("连不上目标 {target}: {e}")
                                }),
                            );
                        }
                    }
                    connections.fetch_sub(1, Ordering::Relaxed);
                    emit_conns(&app, &id, connections.load(Ordering::Relaxed));
                });
            }
        }
    }
    Ok(())
}

fn emit_conns(app: &AppHandle, id: &str, n: usize) {
    let _ = app.emit(
        "forward:status",
        serde_json::json!({ "id": id, "status": "running", "connections": n }),
    );
}
