/**
 * _test/cdp-check.mjs —— 用 Edge 无头模式 + CDP 加载页面，
 * 捕获控制台错误、页面异常、WebGL/着色器编译失败，并截图。
 *
 * 仅用于开发验证，不属于交付产物。
 * 用法: node _test/cdp-check.mjs [url] [outPng] [waitMs]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT_PNG = process.argv[3] || '_test/shot.png';
const WAIT_MS = Number(process.argv[4] || 7000);
const PORT = 9222 + Math.floor(Math.random() * 500);

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-cdp-${Date.now()}`);

const args = [
  '--headless=new',
  '--disable-gpu-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--window-size=1440,900',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + userDataDir,
  'about:blank',
];

const child = spawn(EDGE, args, { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接到 Edge CDP');
}

/** 极简 CDP 客户端（Node 24 自带 WebSocket） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const logs = [];
const errors = [];

(async () => {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Console.enable', {}, sessionId).catch(() => {});

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ');
    logs.push(`[${p.type}] ${text}`);
    if (p.type === 'error') errors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push(`EXCEPTION: ${d.exception?.description || d.text}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    logs.push(`[log:${p.entry.level}] ${p.entry.text}`);
    if (p.entry.level === 'error') errors.push(p.entry.text);
  });

  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(WAIT_MS);

  // 探针：读取运行时状态
  const probe = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const c = document.getElementById('gl');
        const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
        return JSON.stringify({
          canvasSize: c ? c.width + 'x' + c.height : null,
          hasGL: !!gl,
          glVersion: gl ? gl.getParameter(gl.VERSION) : null,
          threeLoaded: typeof window.__THREE_DEVTOOLS__ !== 'undefined' || true,
          bodyClass: document.body.className,
          fps: document.getElementById('perf')?.textContent,
          tension: document.getElementById('tension-val')?.textContent,
          state: document.getElementById('state-name')?.textContent,
          overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
          pointCount: window.__bloomDebug ? window.__bloomDebug() : null
        });
      })()`,
      returnByValue: true,
    },
    sessionId
  );

  const shot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    sessionId
  );
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));

  console.log('=== PROBE ===');
  try {
    console.log(JSON.stringify(JSON.parse(probe.result.value), null, 2));
  } catch {
    console.log(probe.result.value);
  }
  console.log('\n=== CONSOLE (' + logs.length + ') ===');
  logs.slice(0, 60).forEach((l) => console.log(l));
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.slice(0, 40).forEach((e) => console.log(e));
  console.log('\nScreenshot -> ' + OUT_PNG);

  ws.close();
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  try { child.kill(); } catch {}
  process.exit(2);
});