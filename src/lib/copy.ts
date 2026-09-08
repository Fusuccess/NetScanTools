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
