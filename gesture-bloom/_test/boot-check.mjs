/**
 * _test/boot-check.mjs —— 冷启动验证
 *
 * 目标：确认页面**完全使用本地 vendor 资源**即可跑起来，
 * 并测量「导航 → 粒子系统就绪」的真实耗时。
 * 同时统计实际请求过的外部域名（用于证明不再依赖 Three.js CDN）。
 *
 * 用法: node _test/boot-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9900 + Math.floor(Math.random() * 90);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-boot-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5173/?nodegrade=1';

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
  await cdp.send('Network.enable', {}, sessionId);

  const requests = [];
  const errors = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    try {
      requests.push(new URL(p.request.url).host);
    } catch {}
  });
  cdp.on('Runtime.exceptionThrown', (p) =>
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text))
  );
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' && !/QUIC|ERR_/.test(p.entry.text)) {
      errors.push('LOG: ' + p.entry.text);
    }
  });

  const t0 = Date.now();
  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);

  // 轮询直到粒子系统就绪
  let readyMs = null;
  let dbg = null;
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    try {
      const r = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `window.__bloomDebug ? JSON.stringify(window.__bloomDebug()) : null`,
          returnByValue: true,
        },
        sessionId
      );
      if (r.result.value) {
        const d = JSON.parse(r.result.value);
        if (d.particles > 0) {
          dbg = d;
          readyMs = Date.now() - t0;
          break;
        }
      }
    } catch {}
  }

  const hostCounts = {};
  for (const h of requests) hostCounts[h] = (hostCounts[h] || 0) + 1;

  console.log('=== 冷启动结果 ===');
  console.log(`  就绪耗时:   ${readyMs === null ? '超时未就绪' : readyMs + ' ms'}`);
  console.log(`  粒子数:     ${dbg?.particles}`);
  console.log(`  泛光:       ${dbg?.bloom}`);
  console.log(`  着色器错误: ${dbg?.shaderError ?? 'null'}`);
  console.log(`  绘制调用:   ${dbg?.drawCalls}`);
  console.log('\n=== 请求过的域名 ===');
  Object.entries(hostCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([h, c]) => console.log(`  ${String(c).padStart(3)}x  ${h}`));

  const usesThreeCdn = Object.keys(hostCounts).some(
    (h) => h.includes('unpkg.com') || h.includes('jsdelivr.net')
  );
  console.log(`\n  Three.js 是否走了 CDN: ${usesThreeCdn ? '是（未完全本地化）' : '否（已本地化 ✓）'}`);
  console.log(`  控制台错误: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log('    ' + e));

  const ok = readyMs !== null && !usesThreeCdn && errors.length === 0 && !dbg?.shaderError;

  // 存档一张启动截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync('_test/boot-overlay.png', Buffer.from(shot.data, 'base64'));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'} 冷启动检查`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});