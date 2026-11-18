// 一次性：给介绍视频取景用的 CDP 小客户端（Edge 无头 + 1920 取景 + 2x 采样）。
// 只做四件事：连上、设视口、求值后读回、截成 PNG。dev/_shots 本来就不进仓。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EDGE = process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
export const ASSETS = new URL("./assets/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function launch(port = 9345) {
  mkdirSync(ASSETS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "ws-intro-"));
  const edge = spawn(EDGE, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--force-color-profile=srgb", "--font-render-hinting=none",
    // 无头窗口会被当成「被遮挡」把 rAF 停掉，逐帧渲染跑到一半就吊死；这几个开关关掉节流。
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion",
    "about:blank",
  ], { stdio: "ignore" });

  let page = null;
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === "page");
    } catch { /* 端口还没开 */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("Edge 调试端口没就绪");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    seq += 1;
    pending.set(seq, resolve);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const failure = r.result?.exceptionDetails ?? r.exceptionDetails;
    if (failure) throw new Error(String(JSON.stringify(failure)).slice(0, 600));
    return r.result?.result?.value ?? r.result?.value;
  };

  async function viewport(width, height, scale = 2) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  }

  async function hydrate(url, { token, theme } = {}) {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: "about:blank" });
    await sleep(150);
    if (token || theme) {
      const source = [
        token ? `localStorage.setItem("workstream.token", ${JSON.stringify(token)});` : "",
        theme ? `localStorage.setItem("workstream.theme", ${JSON.stringify(theme)});` : "",
      ].join("");
      const added = await send("Page.addScriptToEvaluateOnNewDocument", { source });
      globalThis.__injected = added.result?.identifier ?? null;
    }
    await send("Page.navigate", { url });
    await sleep(300);
    for (let i = 0; i < 80; i += 1) {
      const ready = await evaluate("document.readyState");
      if (ready === "complete") break;
      await sleep(150);
    }
  }

  async function waitFor(expression, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await evaluate(expression)) return true;
      await sleep(200);
    }
    throw new Error(`等待超时：${expression.slice(0, 120)}`);
  }

  async function shoot(name, clip) {
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: clip.scale ?? 2 };
    const r = await send("Page.captureScreenshot", params);
    const file = join(ASSETS, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log("shot", name);
    return file;
  }

  async function close() {
    ws.close();
    edge.kill();
  }

  return { send, evaluate, viewport, hydrate, waitFor, shoot, close, profile };
}

export function token() {
  return import("node:fs").then((fs) => fs.readFileSync(new URL("../ws.token", import.meta.url), "utf8").trim());
}

// 主题偏好写在账号上，localStorage 的预置会被它顶掉；走真实接口改，拍完再改回去。
export async function setTheme(pref, sessionToken) {
  const r = await fetch("http://127.0.0.1:8000/functions/v1/app?action=auth.patch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workstream-token": sessionToken },
    body: JSON.stringify({ prefs: { theme: pref } }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) throw new Error(`auth.patch theme=${pref} 失败：${r.status} ${JSON.stringify(body).slice(0, 200)}`);
}
