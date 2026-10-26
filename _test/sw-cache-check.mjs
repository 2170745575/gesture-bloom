/**
 * _test/sw-cache-check.mjs —— Service Worker 缓存验证
 *
 * 为什么需要这个测试：
 *   模型约 16 MB，而 GitHub Pages 的 Cache-Control 只有 max-age=600（10 分钟），
 *   且对 .wasm/.data/.tflite 不做压缩。国内实测下载速度 38 KB/s，
 *   完整加载要 7 分钟以上，而且每 10 分钟就要重下一次。
 *
 *   sw.js 把资源存进 Cache Storage（不过期），让第二次打开变成瞬间。
 *   这个测试就是把这件事固化成断言，防止以后改坏。
 *
 * 判据不是"耗时变短" —— 在 localhost 上一切都在 100ms 内，
 * 按耗时判断会把"真的下载"误判成"命中缓存"（实测在全新缓存上报过 6/7）。
 * 所以这里用 Service Worker 主动上报的命中事件作为直接证据：
 *   第一次访问 → servedFromCache = 0，且 7 个文件写入缓存
 *   第二次访问 → servedFromCache = 7（网络零流量）
 *
 * 前置：本地服务需已在 5173 端口运行（node server.js 5173）
 * 用法：node _test/sw-cache-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SITE = 'http://localhost:5173/';
const CDP_PORT = 6900 + Math.floor(Math.random() * 90);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `sw-check-${Date.now()}`);
const EXPECTED_FILES = 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 连接失败');
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

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${d}`); }
};

(async () => {
  // 先确认服务在跑，否则后面会以各种奇怪的方式失败
  try {
    const r = await fetch(SITE, { method: 'HEAD' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error(`本地服务未运行（${SITE}）。先执行：node server.js 5173`);
    process.exit(2);
  }

  const child = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--hide-scrollbars', '--window-size=1280,800',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir, 'about:blank',
  ], { stdio: 'ignore' });

  const ws = new WebSocket(await wsUrl());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const ev = async (e) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };
  const waitReady = async (max = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      if (await ev('typeof window.__bloomDebug === "function"') === true) return true;
      await sleep(400);
    }
    return false;
  };
  const waitPreload = async (max = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      const d = await ev('window.__bloomDebug ? JSON.stringify(window.__bloomDebug().preload) : null');
      if (d && d !== null && !d.__err) {
        const j = JSON.parse(d);
        if (j.done) return j;
      }
      await sleep(400);
    }
    return null;
  };

  console.log('=== 1. 第一次访问（全新 profile，缓存为空）===');
  await cdp.send('Page.navigate', { url: SITE }, sessionId);
  await waitReady();
  const p1 = await waitPreload();
  console.log(`  ${JSON.stringify(p1)}`);
  check('预加载完成', p1 && p1.done);
  check('预加载无失败', p1 && !p1.failed);
  check('Service Worker 已接管页面', p1 && p1.swController);
  check('首次访问不应有缓存命中', p1 && p1.servedFromCache === 0,
    `servedFromCache=${p1?.servedFromCache}`);
  check(`${EXPECTED_FILES} 个模型文件已写入 Cache Storage`,
    p1 && p1.cachedInStorage === EXPECTED_FILES, `cachedInStorage=${p1?.cachedInStorage}`);

  console.log('\n=== 2. 确认缓存内容完整（按字节数核对）===');
  const cacheInfo = await ev(`
    (async () => {
      const names = await caches.keys();
      const files = [];
      for (const n of names) {
        const cache = await caches.open(n);
        for (const k of await cache.keys()) {
          const res = await cache.match(k);
          const buf = await res.arrayBuffer();
          files.push({ name: k.url.split('/').pop(), bytes: buf.byteLength });
        }
      }
      return JSON.stringify(files);
    })()
  `);
  const files = JSON.parse(cacheInfo);
  files.forEach((f) => console.log(`    ${String(f.bytes).padStart(9)}  ${f.name}`));
  check(`缓存里有 ${EXPECTED_FILES} 个文件`, files.length === EXPECTED_FILES, `实际 ${files.length}`);
  const wasm = files.find((f) => f.name.endsWith('.wasm'));
  check('WASM 完整（6,026,259 字节）', wasm && wasm.bytes === 6026259, wasm ? `${wasm.bytes}` : '未找到');
  const tflite = files.find((f) => f.name.includes('full.tflite'));
  check('模型完整（5,478,688 字节）', tflite && tflite.bytes === 5478688, tflite ? `${tflite.bytes}` : '未找到');

  console.log('\n=== 3. 第二次访问（应全部来自缓存，网络零流量）===');
  await cdp.send('Page.navigate', { url: SITE }, sessionId);
  await waitReady();
  const p2 = await waitPreload();
  console.log(`  ${JSON.stringify(p2)}`);
  check('预加载完成', p2 && p2.done);
  check(`★ ${EXPECTED_FILES} 个文件全部由 Service Worker 从缓存提供`,
    p2 && p2.servedFromCache === EXPECTED_FILES, `servedFromCache=${p2?.servedFromCache}`);

  console.log('\n=== 4. 缓存状态下开启摄像头 ===');
  await ev(`document.getElementById('start-btn')?.click(); 'x'`);
  let mp = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const s = await ev('JSON.stringify({g: window.__bloomDebug ? window.__bloomDebug().gestureActive : false})');
    if (s && !s.__err && JSON.parse(s).g) { mp = true; console.log(`    MediaPipe 就绪（${i}s）`); break; }
  }
  check('MediaPipe 初始化成功', mp);

  console.log(`\n  通过 ${pass} / ${pass + fail}`);
  ws.close(); child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});