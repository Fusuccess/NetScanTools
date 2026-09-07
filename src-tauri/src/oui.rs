pub fn lookup(mac: &str) -> String {
    let prefix = mac
        .split([':', '-'])
        .take(3)
        .map(|p| p.to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":");
    match prefix.as_str() {
        "00:11:22" | "50:C7:BF" | "C0:06:C3" => "TP-Link".into(),
        "00:1A:11" | "AC:DE:48" | "F0:18:98" | "A4:83:E7" | "88:66:5A" => "Apple, Inc.".into(),
        "00:15:5D" | "00:0D:3A" => "Microsoft".into(),
        "00:50:56" | "00:0C:29" => "VMware".into(),
        "52:54:00" => "QEMU/KVM".into(),
        "B8:27:EB" | "DC:A6:32" | "E4:5F:01" => "Raspberry Pi".into(),
        "00:1B:63" | "00:25:00" => "Apple, Inc.".into(),
        "3C:5A:B4" | "D8:3A:DD" => "Xiaomi".into(),
        "00:E0:4C" => "Realtek".into(),
        "00:1E:06" | "00:90:A9" => "Western Digital".into(),
        "00:11:32" => "Synology".into(),
        "00:18:E7" | "00:24:A5" => "Huawei".into(),
        _ => "Unknown".into(),
    }
}
