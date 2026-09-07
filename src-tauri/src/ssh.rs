use crate::store::{self, SshTunnelConfig};
use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelView {
    #[serde(flatten)]
    pub config: SshTunnelConfig,
    pub status: String,
    pub uptime_secs: u64,
    pub last_error: Option<String>,
}

struct ClientHandler {
    path: PathBuf,
    host_key: String,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let mut map: HashMap<String, String> = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        match map.get(&self.host_key) {
            None => {
                map.insert(self.host_key.clone(), fp);
                let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&map).unwrap_or_default());
                Ok(true)
            }
            Some(old) if old == &fp => Ok(true),
            Some(_) => Ok(false),
        }
    }
}

pub async fn run_tunnel(
    app: AppHandle,
    data_dir: PathBuf,
    cfg: SshTunnelConfig,
    password: Option<String>,
    cancel: CancellationToken,
) {
    let id = cfg.id.clone();
    let result = run_tunnel_inner(app.clone(), data_dir, cfg, password, cancel).await;
    if let Err(err) = result {
        let _ = app.emit(
            "ssh:log",
            log_payload(&id, "ERROR", &err),
        );
        let _ = app.emit(
            "ssh:status",
            serde_json::json!({ "id": id, "status": "error", "lastError": err }),
        );
    }
}

async fn run_tunnel_inner(
    app: AppHandle,
    data_dir: PathBuf,
    cfg: SshTunnelConfig,
    password: Option<String>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let id = cfg.id.clone();
    log(&app, &id, "INFO", &format!(
        "Connecting to {}:{} via Rust SSH...",
        cfg.jump_host, cfg.jump_port
    ));

    let handler = ClientHandler {
        path: store::known_hosts_path(&data_dir),
        host_key: format!("{}:{}", cfg.jump_host, cfg.jump_port),
    };
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    };
    let mut handle = client::connect(
        Arc::new(config),
        (cfg.jump_host.as_str(), cfg.jump_port),
        handler,
    )
    .await
    .map_err(|e| {
        if e.to_string().to_lowercase().contains("unknown")
            || e.to_string().contains("key")
        {
            format!("主机密钥校验失败: {e}")
        } else {
            e.to_string()
        }
    })?;

    let auth = if cfg.auth == "key" {
        if cfg.key_path.trim().is_empty() {
            return Err("未指定私钥文件".into());
        }
        let key = PrivateKey::read_openssh_file(Path::new(&cfg.key_path))
            .map_err(|e| format!("读取私钥失败: {e}"))?;
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        handle
            .authenticate_publickey(
                cfg.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(|e| e.to_string())?
    } else {
        let password = password.ok_or_else(|| "密码认证需要提供密码".to_string())?;
        handle
            .authenticate_password(cfg.username.clone(), password)
            .await
            .map_err(|e| e.to_string())?
    };

    if !matches!(auth, AuthResult::Success) {
        return Err("认证失败".into());
    }
    log(
        &app,
        &id,
        "INFO",
        &format!(
            "Authentication succeeded ({}).",
            if cfg.auth == "key" { "publickey" } else { "password" }
        ),
    );

    let handle = Arc::new(handle);
    let bind = format!("{}:{}", cfg.local_bind, cfg.local_port);
    let listener = TcpListener::bind(&bind)
        .await
        .map_err(|e| format!("监听 {bind} 失败: {e}"))?;
    log(
        &app,
        &id,
        "INFO",
        &format!("Local forwarding listening on {bind}."),
    );
    let _ = app.emit(
        "ssh:status",
        serde_json::json!({ "id": id, "status": "running", "lastError": null }),
    );

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                log(&app, &id, "INFO", "Tunnel stopped.");
                let _ = app.emit("ssh:status", serde_json::json!({ "id": id, "status": "stopped" }));
                break;
            }
            accepted = listener.accept() => {
                let (mut incoming, peer) = accepted.map_err(|e| e.to_string())?;
                let handle = handle.clone();
                let app = app.clone();
                let id = id.clone();
                let target_host = cfg.target_host.clone();
                let target_port = cfg.target_port as u32;
                tokio::spawn(async move {
                    match handle
                        .channel_open_direct_tcpip(
                            target_host,
                            target_port,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(ch) => {
                            let mut ssh_stream = ch.into_stream();
                            let _ = copy_bidirectional(&mut incoming, &mut ssh_stream).await;
                        }
                        Err(e) => {
                            log(&app, &id, "ERROR", &format!("转发失败: {e}"));
                        }
                    }
                });
            }
        }
    }
    Ok(())
}

fn log(app: &AppHandle, id: &str, level: &str, message: &str) {
    let _ = app.emit("ssh:log", log_payload(id, level, message));
}

fn log_payload(id: &str, level: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "ts": chrono_like(),
        "level": level,
        "message": message,
    })
}

fn chrono_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
