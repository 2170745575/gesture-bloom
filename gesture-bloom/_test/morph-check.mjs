/**
 * _test/morph-check.mjs —— 验证形态变换
 *
 * 逐个切换到每种形态，检查：
 *   · 是否真的变形（像素差异）
 *   · 形态是否稳定（形状收敛后不再乱动）
 *   · 无着色器错误
 *   · 覆盖率是否合理（形状不能小到看不见）
 *
 * 同时对每种形态截图存档。
 *
 * 用法: node _test/morph-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 8700 + Math.floor(Math.random() * 90);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-morph-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/?nodegrade=1';

const child = spawn(EDGE, [
  '--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions',
  '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--hide-scrollbars',
  '--window-size=780,540','--remote-debugging-port=' + PORT,'--user-data-dir=' + userDataDir,
  'about:blank',
], { stdio: 'ignore' });

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

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (f) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: { const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; v = (v + pr) & 0xff; break; }
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/** 发光像素的包围盒 + 覆盖率，用来判断「形状是否收敛、是否看得见」 */
function shapeStats(png) {
  const { width, height, channels, data } = png;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, lit = 0, sum = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const L = 0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2];
      n++; sum += L;
      if (L > 70) {
        lit++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return {
    覆盖率: +((lit / n) * 100).toFixed(1),
    平均亮度: +(sum / n).toFixed(1),
    包围盒: lit ? `${maxX - minX}x${maxY - minY}` : 'none',
    宽高比: lit ? +((maxX - minX) / Math.max(1, maxY - minY)).toFixed(2) : 0,
  };
}

function diff(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let ch = 0, t = 0;
  for (let i = 0; i < n; i += a.channels) {
    const la = 0.2126*a.data[i] + 0.7152*a.data[i+1] + 0.0722*a.data[i+2];
    const lb = 0.2126*b.data[i] + 0.7152*b.data[i+1] + 0.0722*b.data[i+2];
    if (Math.abs(la - lb) > 12) ch++;
    t++;
  }
  return +((ch / t) * 100).toFixed(1);
}

let pass = 0, fail = 0;
const check = (n, c, d='') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${d}`); }
};

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
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text);
  });

  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(6000);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };

  await evalJs(`
    document.getElementById('overlay').classList.add('hidden');
    document.body.classList.remove('show-skeleton','cam-on');
    for (const id of ['hud-tl','hud-tr','hud-bl','vignette','hud-shapes']) {
      const el = document.getElementById(id); if (el) el.style.display='none';
    }
    'ok'
  `);

  const shoot = async (tag) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const buf = Buffer.from(s.data, 'base64');
    if (tag) fs.writeFileSync(`_test/shape-${tag}.png`, buf);
    return decodePng(buf);
  };

  // 全开状态，让形态完整展开
  await evalJs(`window.__bloomSetTension(1); window.__bloomSnap(); 'x'`);
  await sleep(2500);

  const shapes = await evalJs(
    `JSON.stringify((window.__bloomExposeScene().shapeDefs).map(d => ({id:d.id,name:d.name,icon:d.icon})))`
  );
  const list = JSON.parse(shapes);
  console.log(`形态列表: ${list.map(s => s.icon + s.name).join('  ')}\n`);

  console.log('形态      覆盖率  平均亮度   包围盒    宽高比   像素差异(vs花朵)');
  console.log('-'.repeat(72));

  let flowerShot = null;
  const results = [];

  for (const s of list) {
    await evalJs(`window.__bloomExposeScene().setShape('${s.id}'); 'x'`);
    // 等待变形 + 姿态归位完成。
    // 需要比"缓动收敛"更久：morph 约 2 秒到 1.0，
    // 但 rotation.y 的归零是另一条 0.92/帧 的指数衰减，
    // 大约还要 1.5 秒才能转到正对相机。过早截图会拍到"歪的"形状。
    await sleep(5000);

    const png = await shoot(s.id);
    const st = shapeStats(png);
    // 记录姿态，便于判断"形状看起来歪"到底是形状数据问题还是残留旋转
    const pose = await evalJs(`(()=>{const s=window.__bloomExposeScene();const p=s.points.rotation;
      return JSON.stringify({x:+p.x.toFixed(3),y:+p.y.toFixed(3),z:+p.z.toFixed(3),
        camY:+s.camera.position.y.toFixed(2),camZ:+s.camera.position.z.toFixed(2),
        tgtY:+s.cameraTarget.y.toFixed(2)});})()`);
    if (s.id === 'flower') flowerShot = png;

    const d = flowerShot && s.id !== 'flower' ? diff(flowerShot, png) : null;
    results.push({ ...s, ...st, diff: d, pose: JSON.parse(pose) });

    console.log(
      `${(s.icon + s.name).padEnd(8)} ${String(st.覆盖率 + '%').padStart(7)} ` +
      `${String(st.平均亮度).padStart(9)} ${String(st.包围盒).padStart(10)} ` +
      `${String(st.宽高比).padStart(8)} ${String(d === null ? '-' : d + '%').padStart(14)}  ${pose}`
    );
  }

  console.log('');
  // 着色器错误必须最先检查：一旦片段着色器编译失败，
  // 整个花朵会退化成无法辨识的模糊光云，
  // 而"覆盖率/亮度"这类统计量看起来仍然"正常"，很容易误判。
  const shaderErr = await evalJs(
    `window.__bloomDebug().shaderError`
  );
  check('着色器编译无错误', !shaderErr, String(shaderErr).slice(0, 200));

  /* ---------- 形状是否完整入镜（这条曾导致"形状显示不出来"） ----------
   * 之前按包围盒跨度归一化，蝴蝶/星系/心形这类近似圆形的平面图形
   * 对角方向延伸到 1.41 倍，屏幕垂直占比达到 110~122%，直接溢出视口，
   * 用户看到的就是"只剩一圈弧线、形状显示不出来"。
   * 现在改为按最大半径归一化，这里把「不溢出」固化成断言。 */
  await evalJs(`window.__bloomExposeScene().setShape('butterfly'); 'x'`);
  await sleep(4500);
  const projected = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene();
      const cam = s.camera;
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const rows = [];
      for (const d of s.shapeDefs) {
        const arr = d.id === 'flower'
          ? s.points.geometry.getAttribute('position').array
          : s.shapeData[d.id];
        if (!arr) continue;
        const mv = cam.matrixWorldInverse.elements;
        const pj = cam.projectionMatrix.elements;
        let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
        const step = Math.max(1, Math.floor((arr.length/3)/4000));
        for (let i=0;i<arr.length/3;i+=step) {
          const x=arr[i*3],y=arr[i*3+1],z=arr[i*3+2];
          const vx=mv[0]*x+mv[4]*y+mv[8]*z+mv[12];
          const vy=mv[1]*x+mv[5]*y+mv[9]*z+mv[13];
          const vz=mv[2]*x+mv[6]*y+mv[10]*z+mv[14];
          const cx2=pj[0]*vx+pj[4]*vy+pj[8]*vz+pj[12];
          const cy2=pj[1]*vx+pj[5]*vy+pj[9]*vz+pj[13];
          const cw=pj[3]*vx+pj[7]*vy+pj[11]*vz+pj[15];
          if (cw<=0) continue;
          const nx=cx2/cw, ny=cy2/cw;
          if(nx<minx)minx=nx; if(nx>maxx)maxx=nx;
          if(ny<miny)miny=ny; if(ny>maxy)maxy=ny;
        }
        rows.push({ name: d.name, w: (maxx-minx)/2, h: (maxy-miny)/2,
                    overflow: (minx<-1||maxx>1||miny<-1||maxy>1) });
      }
      return JSON.stringify(rows);
    })()
  `);
  const rows = JSON.parse(projected);
  console.log('  各形状屏幕占比:');
  for (const r of rows) {
    console.log(`    ${r.name.padEnd(4)} 宽 ${(r.w*100).toFixed(0)}%  高 ${(r.h*100).toFixed(0)}%`);
  }
  for (const r of rows) {
    check(`${r.name}：完整入镜（不溢出视口）`, !r.overflow,
      `宽=${(r.w*100).toFixed(0)}% 高=${(r.h*100).toFixed(0)}%`);
  }
  // 也要有足够存在感，不能小得看不见
  for (const r of rows) {
    check(`${r.name}：大小合适（高 > 20%）`, r.h > 0.20, `高=${(r.h*100).toFixed(0)}%`);
  }

  // 每种形态都要看得见
  for (const r of results) {
    check(`${r.name}：形态可见（覆盖率 > 3%）`, r.覆盖率 > 3, `覆盖率=${r.覆盖率}%`);
  }
  // 每种形态都要与花朵明显不同
  for (const r of results.filter(x => x.id !== 'flower')) {
    check(`${r.name}：与花朵形态明显不同（差异 > 12%）`, r.diff > 12, `diff=${r.diff}%`);
  }
  // 无错误
  check('无着色器/运行时错误', errors.length === 0, errors.slice(0,3).join(' | '));

  // 变形后是否稳定（不应"糊掉"、发散、抖动）
  //
  // 判据说明：不能只看「帧间变化」。整个场景每帧都在动
  // （蝴蝶扇翅、星尘漂移、每颗粒子闪烁、泛光强度随绽放起伏…），
  // 实测把 update 换成「只 render」时变化为 0%，说明全部来自正常动画。
  //
  // 所以这里测的是**几何稳定性**：直接读 GPU 属性数据，
  // 确认变形收敛后顶点位置不再漂移。
  await evalJs(`window.__bloomExposeScene().setShape('butterfly'); 'x'`);
  await sleep(5000);

  const geoStable = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene();
      const attr = s.points.geometry.getAttribute('aPosMorph');
      // 采样一批顶点，记录当前值
      s.__probeBefore = Array.from(attr.array.slice(0, 900));
      return 'captured';
    })()
  `);
  await sleep(2500);
  const drift = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene();
      const attr = s.points.geometry.getAttribute('aPosMorph');
      const before = s.__probeBefore;
      let maxDiff = 0;
      for (let i = 0; i < before.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(attr.array[i] - before[i]));
      }
      return maxDiff;
    })()
  `);
  console.log(`\n变形收敛后顶点最大漂移: ${Number(drift).toFixed(6)}（应为 0，说明形状已稳定）`);
  check('变形后形状几何稳定（顶点无漂移）', Number(drift) < 1e-6, `drift=${drift}`);

  console.log(`\n  通过 ${pass} / ${pass + fail}`);
  console.log(`  控制台错误: ${errors.length}`);
  errors.slice(0, 5).forEach(e => console.log('    ' + e));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});