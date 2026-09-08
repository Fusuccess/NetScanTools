use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub timeout_ms: u64,
    pub concurrency: u32,
    pub common_ports: Vec<u16>,
    pub default_icmp: bool,
    pub default_tcp: bool,
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            timeout_ms: 500,
            concurrency: 64,
            common_ports: vec![
                21, 22, 23, 25, 53, 80, 110, 139, 143, 443, 445, 3306, 3389, 5432, 5900, 6379, 8080,
                8443,
            ],
            default_icmp: true,
            default_tcp: true,
            theme: "light".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub id: String,
    pub alias: String,
    pub local_bind: String,
    pub local_port: u16,
    pub jump_host: String,
    pub jump_port: u16,
    pub username: String,
    pub auth: String,
    pub key_path: String,
    pub target_host: String,
    pub target_port: u16,
}

pub fn load_settings(dir: &Path) -> Settings {
    read_json(&dir.join("settings.json")).unwrap_or_default()
}

pub fn save_settings(dir: &Path, settings: &Settings) -> Result<(), String> {
    write_json(&dir.join("settings.json"), settings)
}

pub fn load_tunnels(dir: &Path) -> Vec<SshTunnelConfig> {
    read_json(&dir.join("tunnels.json")).unwrap_or_default()
}

pub fn save_tunnels(dir: &Path, tunnels: &[SshTunnelConfig]) -> Result<(), String> {
    write_json(&dir.join("tunnels.json"), tunnels)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardConfig {
    pub id: String,
    pub bind_ip: String,
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

pub fn load_forwards(dir: &Path) -> Vec<ForwardConfig> {
    read_json(&dir.join("forwards.json")).unwrap_or_default()
}

pub fn save_forwards(dir: &Path, forwards: &[ForwardConfig]) -> Result<(), String> {
    write_json(&dir.join("forwards.json"), forwards)
}

pub fn known_hosts_path(dir: &Path) -> PathBuf {
    dir.join("known_hosts.json")
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}
