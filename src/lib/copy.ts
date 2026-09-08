import { invoke } from "@tauri-apps/api/core";

export const scanHotkey = /Mac/.test(navigator.platform) ? "⌘R" : "Ctrl+R";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}

export function portStateLabel(state: string) {
  if (state === "open") return "开放";
  if (state === "closed") return "关闭";
  return "超时";
}

export function exportFilename(kind: string, ip: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const host = (ip || "unknown").replace(/[<>:"/\\|?*]+/g, "-");
  return `${kind}_${host}_${ts}.tsv`;
}

export async function downloadText(filename: string, text: string) {
  await invoke("save_text_file", { filename, contents: text });
}
