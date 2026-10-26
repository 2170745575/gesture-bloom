/**
 * _test/visual-check.mjs —— 视觉验证
 *
 * 绕过启动遮罩，分别在 tension = 0 / 0.5 / 1 下截图，
 * 并输出粒子系统的运行时状态。
 *
 * 默认带 ?nodegrade=1，关闭性能自动降级，
 * 以便在软件渲染（swiftshader）环境下也能看到完整粒子数 + 泛光。
 *
 * 用法: node _test/visual-check.mjs [url]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5173/?nodegrade=1';
const PORT = 9700 + Math.floor(Math.random() * 200);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-vis-${Date.now()}`);

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
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.handlers.get(m.method)?.forEach((h) => h(m.params));
    });
  }
  on(m, f) {
    if (!this.handlers.has(m)) this.handlers.set(m, []);
    this.handlers.get(m).push(f);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

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

  cdp.on('Runtime.exceptionThrown', (p) =>
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text))
  );
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text);
  });

  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(6000);

  const evalJs = async (expr) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return r.result?.value;
  };

  // 关闭遮罩、关闭骨架与摄像头叠加，只看粒子本体
  await evalJs(`
    document.getElementById('overlay').classList.add('hidden');
    document.body.classList.remove('show-skeleton', 'cam-on');
    'ok'
  `);

  const shots = [];

  for (const [name, tension] of [['bud', 0.0], ['mid', 0.5], ['bloom', 1.0]]) {
    // 把 tension 钉住（覆盖主循环的输入源），再立即把缓动推到目标
    await evalJs(`window.__bloomSetTension(${tension}); 'set'`);
    await sleep(2500);
    await evalJs(`window.__bloomSetTension(${tension}); window.__bloomSnap(); 'hold'`);
    await sleep(900);

    const dbg = JSON.parse(await evalJs(`JSON.stringify(window.__bloomDebug())`));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const out = `_test/flower-${name}.png`;
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    shots.push({
      name,
      spread: dbg.spread,
      particles: dbg.particles,
      bloom: dbg.bloom,
      shaderError: dbg.shaderError,
      out,
    });
  }

  console.log(JSON.stringify(shots, null, 2));
  console.log('\nERRORS(' + errors.length + '):');
  errors.forEach((e) => console.log('  ' + e));

  ws.close();
  child.kill();
  await sleep(300);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try {
    child.kill();
  } catch {}
  process.exit(2);
});