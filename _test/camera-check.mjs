/**
 * _test/camera-check.mjs —— 用「假摄像头」验证摄像头链路
 *
 * Edge/Chrome 的 --use-fake-device-for-media-stream 会提供一个合成视频源，
 * 所以可以在无人值守环境下走完 getUserMedia → <video> → MediaPipe 的全流程，
 * 从而定位「自动演示能用、摄像头不能用」的具体失败点。
 *
 * 用法: node _test/camera-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9600 + Math.floor(Math.random() * 150);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-cam-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/';

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--window-size=1280,800',
    // 关键：提供合成摄像头 + 自动授权
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP connect failed');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.handlers.get(m.method)?.forEach((h) => h(m.params));
    });
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const logs = [];
const errors = [];

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${p.type}] ${text}`);
    if (p.type === 'error') errors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push('EXC: ' + (d.exception?.description || d.text));
  });
  cdp.on('Log.entryAdded', (p) => {
    logs.push(`[log:${p.entry.level}] ${p.entry.text}`);
    if (p.entry.level === 'error') errors.push(p.entry.text);
  });

  // 浏览器是否允许 MediaStream（权限状态）
  await cdp.send('Browser.grantPermissions', {
    origin: new URL(URL_TO_TEST).origin,
    permissions: ['videoCapture'],
  }, sessionId).catch(() => {});

  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(5000);

  const evalJs = async (expr) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };

  /* ---------- 1. 环境能力检查 ---------- */
  console.log('=== 1. 环境能力 ===');
  const env = await evalJs(`JSON.stringify({
    isSecureContext: window.isSecureContext,
    origin: location.origin,
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    permissionsApi: !!navigator.permissions
  })`);
  console.log('  ' + env);

  /* ---------- 2. 直接调 getUserMedia ---------- */
  console.log('\n=== 2. 直接调用 getUserMedia ===');
  const gum = await evalJs(`
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const t = s.getVideoTracks()[0];
        return JSON.stringify({ ok: true, label: t.label, readyState: t.readyState,
          settings: t.getSettings ? t.getSettings() : null });
      } catch (e) {
        return JSON.stringify({ ok: false, name: e.name, message: e.message });
      }
    })()
  `);
  console.log('  ' + gum);

  /* ---------- 3. 点击「开启摄像头」按钮，走真实流程 ---------- */
  console.log('\n=== 3. 点击「开启摄像头，开始体验」 ===');
  await evalJs(`document.getElementById('start-btn').click(); 'clicked'`);

  // 分阶段轮询，记录每一步状态
  for (let i = 1; i <= 12; i++) {
    await sleep(1500);
    const st = await evalJs(`JSON.stringify({
      status: document.getElementById('status')?.textContent,
      statusClass: document.getElementById('status')?.className,
      hasStream: !!document.getElementById('cam').srcObject,
      videoReady: document.getElementById('cam').readyState,
      videoSize: document.getElementById('cam').videoWidth + 'x' + document.getElementById('cam').videoHeight,
      overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
      bodyClass: document.body.className,
      dbg: window.__bloomDebug ? window.__bloomDebug() : null
    })`);
    console.log(`  [${(i * 1.5).toFixed(1)}s] ${st}`);

    const parsed = JSON.parse(st);
    if (parsed.overlayHidden) {
      console.log('  -> 遮罩已隐藏，已进入体验态');
      break;
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync('_test/camera-flow.png', Buffer.from(shot.data, 'base64'));

  console.log('\n=== 控制台输出 ===');
  logs.slice(0, 40).forEach((l) => console.log('  ' + l));
  console.log('\n=== 错误 (' + errors.length + ') ===');
  errors.slice(0, 20).forEach((e) => console.log('  ' + e));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});