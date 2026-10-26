/**
 * _test/responsive-check.mjs —— 响应式布局验证
 *
 * 在多个视口尺寸下加载页面，检查：
 *   1. 无控制台错误
 *   2. 渲染画布尺寸与视口一致
 *   3. HUD 元素都在视口内、互不重叠、不溢出
 *   4. 启动卡片在竖屏小屏上不溢出
 *
 * 用法: node _test/responsive-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9800 + Math.floor(Math.random() * 150);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-resp-${Date.now()}`);
const BASE = 'http://127.0.0.1:5173/?nodegrade=1';

const VIEWPORTS = [
  { name: 'desktop-1920', w: 1920, h: 1080, mobile: false },
  { name: 'laptop-1440', w: 1440, h: 900, mobile: false },
  { name: 'iphone-390', w: 390, h: 844, mobile: true },
  { name: 'iphone-se-375', w: 375, h: 667, mobile: true },
  { name: 'android-360', w: 360, h: 800, mobile: true },
  { name: 'landscape-844', w: 844, h: 390, mobile: true },
  { name: 'ipad-820', w: 820, h: 1180, mobile: true },
];

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

const PROBE = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height,r:b.right,b:b.bottom}; };
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { vw, vh, overflow: [], overlaps: [], missing: [] };

  const ids = ['hud-tl','hud-tr','hud-bl','overlay','gl','cam','skeleton'];
  const els = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out.missing.push(id); continue; }
    els[id] = el;
  }

  // 溢出检查：HUD 与卡片不能超出视口
  for (const [id, el] of Object.entries(els)) {
    if (id === 'gl' || id === 'cam' || id === 'skeleton') continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    if (b.right > vw + 1.5 || b.bottom > vh + 1.5 || b.x < -1.5 || b.y < -1.5) {
      out.overflow.push({ id, x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.right), bottom: Math.round(b.bottom) });
    }
  }

  // 重叠检查：三个 HUD 区不应互相压住
  const hudIds = ['hud-tl','hud-tr','hud-bl'].filter(i => els[i]);
  for (let i = 0; i < hudIds.length; i++) {
    for (let j = i + 1; j < hudIds.length; j++) {
      const a = els[hudIds[i]].getBoundingClientRect();
      const b = els[hudIds[j]].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) {
        out.overlaps.push({ a: hudIds[i], b: hudIds[j], ox: Math.round(ox), oy: Math.round(oy) });
      }
    }
  }

  // 画布必须覆盖整个视口
  const gl = els.gl;
  if (gl) {
    const b = gl.getBoundingClientRect();
    out.canvas = { w: gl.width, h: gl.height, cssW: Math.round(b.width), cssH: Math.round(b.height) };
    out.canvasCovers = Math.abs(b.width - vw) < 2 && Math.abs(b.height - vh) < 2;
  }

  // 启动卡片是否在视口内
  const card = document.querySelector('.card');
  if (card) {
    const b = card.getBoundingClientRect();
    out.card = { w: Math.round(b.width), h: Math.round(b.height), fits: b.height <= vh + 1 && b.width <= vw + 1 };
  }

  // 横向滚动条不应出现
  out.docScrollW = document.documentElement.scrollWidth;
  out.hasHScroll = document.documentElement.scrollWidth > vw + 1;

  out.debug = window.__bloomDebug ? window.__bloomDebug() : null;
  return JSON.stringify(out);
})()`;

let pass = 0, fail = 0;

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

  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) =>
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text))
  );
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text);
  });

  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  await sleep(5000);

  for (const vp of VIEWPORTS) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: vp.mobile ? 3 : 1,
        mobile: vp.mobile,
      },
      sessionId
    );
    await sleep(1400);

    const raw = await cdp.send(
      'Runtime.evaluate',
      { expression: PROBE, returnByValue: true },
      sessionId
    );
    const info = JSON.parse(raw.result.value);

    const problems = [];
    if (info.overflow.length) problems.push('溢出: ' + JSON.stringify(info.overflow));
    if (info.overlaps.length) problems.push('重叠: ' + JSON.stringify(info.overlaps));
    if (info.missing.length) problems.push('缺失: ' + info.missing.join(','));
    if (info.hasHScroll) problems.push(`横向滚动 scrollWidth=${info.docScrollW} > ${info.vw}`);
    if (!info.canvasCovers) problems.push(`画布未铺满: ${JSON.stringify(info.canvas)}`);
    if (info.card && !info.card.fits) problems.push(`启动卡片溢出: ${JSON.stringify(info.card)}`);

    if (problems.length === 0) {
      pass++;
      console.log(`  PASS  ${vp.name.padEnd(16)} ${vp.w}x${vp.h}  canvas=${info.canvas.cssW}x${info.canvas.cssH}  粒子=${info.debug?.particles}`);
    } else {
      fail++;
      console.log(`  FAIL  ${vp.name.padEnd(16)} ${vp.w}x${vp.h}`);
      problems.forEach((p) => console.log(`          ${p}`));
    }

    // 移动端截图存档（竖屏与横屏各一张）
    if (vp.name === 'iphone-390' || vp.name === 'landscape-844') {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(`_test/responsive-${vp.name}.png`, Buffer.from(shot.data, 'base64'));
    }
  }

  console.log(`\n  通过 ${pass} / ${pass + fail}`);
  console.log(`  控制台错误: ${errors.length}`);
  errors.slice(0, 10).forEach((e) => console.log('    ' + e));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});