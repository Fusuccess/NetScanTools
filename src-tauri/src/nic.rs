use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nic {
    pub name: String,
    pub ipv4: String,
    pub cidr_hint: String,
}

pub fn list_nics() -> Result<Vec<Nic>, String> {
    let mut nics = Vec::new();
    let ifaces = if_addrs::get_if_addrs().map_err(|e| e.to_string())?;
    for iface in ifaces {
        let if_addrs::IfAddr::V4(v4) = iface.addr else {
            continue;
        };
        nics.push(Nic {
            name: iface.name,
            ipv4: v4.ip.to_string(),
            cidr_hint: cidr_hint(v4.ip, v4.netmask),
        });
    }
    nics.sort_by(|a, b| {
        let al = a.ipv4.starts_with("127.");
        let bl = b.ipv4.starts_with("127.");
        al.cmp(&bl).then_with(|| a.name.cmp(&b.name))
    });
    Ok(nics)
}

fn cidr_hint(ip: Ipv4Addr, mask: Ipv4Addr) -> String {
    let prefix: u32 = mask.octets().iter().map(|b| b.count_ones()).sum();
    let network = u32::from(ip) & u32::from(mask);
    format!("{}/{}", Ipv4Addr::from(network), prefix)
}
