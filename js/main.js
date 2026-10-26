/**
 * main.js —— 应用主控
 *
 * 串联：摄像头 → MediaPipe → tension → spread 缓动 → Three.js 粒子
 * 同时负责：UI 绑定、权限错误处理、自动演示模式、响应式、性能自适应。
 */

import { resolveRuntimeConfig, CONFIG } from './config.js';
import { HandTracker, computeTension, tensionToSpread, spreadStateName } from './handTracking.js';
import { ActionDetector } from './gestures.js';
import { FlowerScene } from './scene.js';
import {
  registerServiceWorker,
  preloadMediaPipe,
  formatMB,
  ASSET_TOTAL_BYTES,
  ASSET_COUNT,
} from './preload.js';

/* ================================================================== *
 * DOM
 * ================================================================== */

const $ = (id) => document.getElementById(id);

const dom = {
  video: $('cam'),
  skeleton: $('skeleton'),
  canvas: $('gl'),
  overlay: $('overlay'),
  startBtn: $('start-btn'),
  skipBtn: $('skip-btn'),
  status: $('status'),
  preload: $('preload'),
  preloadBar: $('preload-bar'),
  preloadText: $('preload-text'),
  tensionVal: $('tension-val'),
  meterFill: $('meter-fill'),
  stateName: $('state-name'),
  perf: $('perf'),
  hint: $('hint'),
  btnCam: $('btn-cam'),
  btnSkel: $('btn-skel'),
  btnAuto: $('btn-auto'),
  btnReset: $('btn-reset'),
  shapeRow: $('shape-row'),
  shapeCurrent: $('shape-current'),
  shapeToast: $('shape-toast'),
};

/* ================================================================== *
 * 全局状态
 * ================================================================== */

const cfg = resolveRuntimeConfig();

const state = {
  /** 当前绽放程度（缓动后），0 = 花苞，1 = 全开 */
  spread: 0,
  /** 当前 tension（缓动后） */
  tension: 0,
  /** 手势路径是否激活 */
  gestureActive: false,
  /** 自动演示模式 */
  autoDemo: false,
  /** 手部位置（归一化 [-1,1]） */
  handX: 0,
  handY: 0,
  hasHand: false,
  /** 帧率统计 */
  fps: 60,
  /** 调试用：非 null 时强制使用该张力值 */
  tensionOverride: null,
  /** 单指追踪：指尖位置与激活强度 */
  fingerX: 0,
  fingerY: 0,
  fingerActive: 0,
  /** 手指旋转累积角（弧度） */
  rotation: 0,
  /** 捏合 [0=捏紧, 1=张开] */
  pinch: 0.5,
  /** 挥手强度 */
  wave: 0,
};

/** 动作事件检测器（边沿触发 + 冷却） */
const actions = new ActionDetector();

let tracker = null;
let scene = null;
let lastTime = performance.now();
let frameCount = 0;
let fpsAccum = 0;
let perfTick = 0;
/** 性能自适应：连续掉帧则分级降低粒子数与泛光（可用 ?nodegrade=1 关闭） */
const NO_DEGRADE =
  new URLSearchParams(location.search).has('nodegrade') ||
  new URLSearchParams(location.search).has('quality');

/* ================================================================== *
 * 主循环
 * ================================================================== */

function loop(now) {
  requestAnimationFrame(loop);

  const dtRaw = (now - lastTime) / 1000;
  lastTime = now;
  // 标签页切回时 dt 会很大，夹紧防止画面跳变
  const dt = Math.min(dtRaw, 1 / 20);
  // 60fps 归一化系数：让 0.1 的缓动系数在不同刷新率下手感一致
  const dtScale = dt * 60;

  /* ---------- 1. 取手势输入 ---------- */
  if (state.tensionOverride !== null) {
    // 调试/演示：强制固定张力值（绕过所有输入源）
    state.tension = state.tensionOverride;
    state.hasHand = true;
  } else if (tracker && tracker.running) {
    tracker.update(dtScale);
    state.hasHand = tracker.hasHand;
    // 手不在画面时，tension 也平滑回落到 0（tracker 内部已做衰减）
    state.tension = tracker.tension;
    state.handX = tracker.center.x;
    state.handY = tracker.center.y;
  } else if (state.autoDemo) {
    updateAutoDemo(now / 1000);
  } else {
    // 无摄像头模式：保持在半开状态，缓慢呼吸
    state.tension = 0.5 + Math.sin(now / 1400) * 0.42;
    state.handX = Math.sin(now / 2600) * 0.45;
    state.handY = Math.cos(now / 3100) * 0.28;
    state.hasHand = true;
  }

  /* ---------- 1b. 扩展手势信号 ---------- */
  updateGestureSignals(dt);

  /* ---------- 2. tension → targetSpread ---------- */
  const targetSpread = tensionToSpread(state.tension);

  /* ---------- 3. 缓动：currentSpread += (target - current) * 0.1 ---------- */
  // 需求给定的 0.1 是 60fps 下的经验值，换算成与帧率无关的指数缓动：
  const k = 1 - Math.pow(1 - CONFIG.gesture.easing, dtScale);
  state.spread += (targetSpread - state.spread) * k;

  /* ---------- 4. 渲染 ---------- */
  scene?.update(dt, {
    spread: state.spread,
    tension: state.tension,
    handX: state.handX,
    handY: state.handY,
    hasHand: state.hasHand,
    // 扩展手势信号
    fingerX: state.fingerX,
    fingerY: state.fingerY,
    fingerActive: state.fingerActive,
    rotation: state.rotation,
    pinch: state.pinch,
  });

  /* ---------- 5. UI ---------- */
  updateUI(dt);

  /* ---------- 6. 性能自适应 ---------- */
  monitorPerformance(dt);
}

/* ================================================================== *
 * 扩展手势信号 → 场景参数
 * ================================================================== */

/**
 * 把 gestures.js 提取的信号整理成 scene.update 需要的字段。
 *
 * 同时在这里处理「动作事件」（需要触发一次而不是持续生效的动作）。
 */
function updateGestureSignals(dt) {
  const g = tracker?.gestures?.state;

  if (!g || !tracker?.hasHand) {
    // 没有手势输入时，所有附加动作平滑回中位
    state.fingerX += (0 - state.fingerX) * 0.08;
    state.fingerY += (0 - state.fingerY) * 0.08;
    state.fingerActive += (0 - state.fingerActive) * 0.08;
    state.rotation += (0 - state.rotation) * 0.06;
    state.pinch += (0.5 - state.pinch) * 0.06;
    state.wave *= 0.94;
    return;
  }

  /* ---------- 单指追踪 ---------- */
  // 「食指单独伸出」时激活；其余手指也伸出时逐渐退出，
  // 避免手掌张开（本来就该整朵绽放）时被单指逻辑干扰。
  const wantFinger = g.indexOnly ? 1 : 0;
  state.fingerActive += (wantFinger - state.fingerActive) * 0.12;

  if (state.fingerActive > 0.01) {
    // 指尖位置：x 直接映射（已镜像），y 取反（屏幕坐标 y 向下）
    state.fingerX = g.fingerPos.x * 0.9;
    state.fingerY = -g.fingerPos.y * 0.9;
  }

  /* ---------- 手指旋转 → 花朵旋转 ---------- */
  // 直接使用累积角：手掌转多少，花朵就转多少。
  // 花苞状态放大 1.35 倍，让闭合时的旋转更醒目。
  const spinGain = state.spread < 0.4 ? 1.35 : 1.0;
  state.rotation = g.rotationAccum * spinGain;

  /* ---------- 捏合 ---------- */
  state.pinch = g.pinch;

  /* ---------- 挥手 ---------- */
  state.wave = g.wave;

  /* ---------- 动作事件 ---------- */
  // 挥手 → 把花瓣「吹散」（触发一次）
  if (actions.peak('wave', g.wave, 0.55, dt, 1.2)) {
    scene?.triggerScatter();
  }
  // 五指全部张开 → 一次性脉冲（强化「完全绽放」的瞬间）
  if (actions.edge('allOpen', g.extendedCount >= 5, dt, 1.0)) {
    scene?.triggerBurst(1.0);
  }
}

/* ================================================================== *
 * 自动演示：无摄像头时的张力曲线（模拟握拳→张开的循环）
 * ================================================================== */

function updateAutoDemo(t) {
  // 一个 9 秒的循环：0~3s 握拳静止，3~5s 张开，5~7s 保持，7~9s 收拢
  const period = 9;
  const p = (t % period) / period;
  let tension;
  if (p < 0.28) {
    tension = 0.06 + Math.sin(t * 3.1) * 0.03;                 // 握拳微颤
  } else if (p < 0.48) {
    const u = (p - 0.28) / 0.2;
    tension = 0.06 + easeInOutCubic(u) * 0.9;                   // 张开
  } else if (p < 0.72) {
    tension = 0.96 + Math.sin(t * 1.7) * 0.04;                  // 保持张开
  } else {
    const u = (p - 0.72) / 0.28;
    tension = 0.96 - easeInOutCubic(u) * 0.9;                   // 收拢
  }
  state.tension = Math.max(0, Math.min(1, tension));
  // 手部位置缓慢绕圈，展示跟随效果
  state.handX = Math.sin(t * 0.62) * 0.5;
  state.handY = Math.cos(t * 0.45) * 0.32;
  state.hasHand = true;
}

const easeInOutCubic = (x) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/* ================================================================== *
 * UI 更新（节流到 ~20Hz，避免每帧触发样式计算）
 * ================================================================== */

let uiAccum = 0;
function updateUI(dt) {
  uiAccum += dt;
  if (uiAccum < 0.05) return;
  uiAccum = 0;

  const t = state.tension;
  dom.tensionVal.textContent = t.toFixed(2);
  dom.meterFill.style.width = `${(t * 100).toFixed(1)}%`;
  dom.stateName.textContent = spreadStateName(state.spread);

  // HUD 边框随张力微微发光
  dom.meterFill.style.boxShadow =
    `0 0 ${8 + t * 20}px rgba(${Math.round(154 + t * 100)}, ${Math.round(217 - t * 60)}, 255, ${0.35 + t * 0.5})`;
}

/* ================================================================== *
 * 性能监控与自适应降级
 * ================================================================== */

const DEGRADE_STEPS = [
  // 每一级只降一点，并且**保留泛光**——泛光才是"画质"的关键，
  // 之前一刀切掉泛光会让画面瞬间变平、看起来像"低画质"。
  { particleScale: 0.78, bloomScale: 0.75 },
  { particleScale: 0.62, bloomScale: 0.55 },
  { particleScale: 0.48, bloomScale: 0.35 },
];
let degradeLevel = 0;
let lowFpsStreak = 0;
/** 距离上次降级/恢复的冷却，避免在阈值附近反复横跳 */
let perfCooldown = 3.0;

function monitorPerformance(dt) {
  frameCount++;
  fpsAccum += dt;
  perfCooldown = Math.max(0, perfCooldown - dt);

  if (fpsAccum < 0.5) return;

  state.fps = frameCount / fpsAccum;
  frameCount = 0;
  fpsAccum = 0;

  perfTick++;
  if (perfTick % 2 === 0) {
    dom.perf.textContent = `${state.fps.toFixed(0)} FPS · ${scene?.particleCount ?? 0} 粒子`;
  }

  if (NO_DEGRADE || !scene) return;

  const fps = state.fps;
  if (!(fps > 0)) return;

  // 判定门槛要留足余量：
  //   低于 26 FPS 且持续 3 秒才降级（之前是 32 FPS / 2 秒，太敏感，
  //   启动瞬间或切换形态的卡顿就会触发，导致"一直在低画质"）；
  //   高于 52 FPS 且持续足够久才逐级恢复。
  //
  // 另外：降级只减粒子与泛光强度，**不再关闭泛光**——
  // 泛光对"画质观感"影响很大，一刀切关掉会让画面立刻变得很平、
  // 看起来像"低画质"。层级也是渐进的（0.78 / 0.62 / 0.48）。
  if (fps < 26) {
    lowFpsStreak++;
    if (lowFpsStreak >= 6 && degradeLevel < DEGRADE_STEPS.length && perfCooldown <= 0) {
      const step = DEGRADE_STEPS[degradeLevel];
      degradeLevel++;
      lowFpsStreak = 0;
      perfCooldown = 4.0;

      const nextCount = Math.max(
        4000,
        Math.round((scene.particleCount || 18000) * step.particleScale)
      );
      scene.setParticleCount(nextCount);
      scene.setBloomScale(step.bloomScale);
      console.info(
        `[perf] 帧率偏低(${fps.toFixed(0)})，降级到第 ${degradeLevel} 级：` +
          `粒子 ${nextCount}，泛光 ×${step.bloomScale}`
      );
    }
  } else if (fps > 52) {
    // 帧率恢复后逐级升回去，避免"一旦降级就永远低画质"
    lowFpsStreak--;
    if (lowFpsStreak <= -10 && degradeLevel > 0 && perfCooldown <= 0) {
      degradeLevel--;
      lowFpsStreak = 0;
      perfCooldown = 5.0;

      const targetScale =
        degradeLevel === 0 ? 1 : DEGRADE_STEPS[degradeLevel - 1].particleScale;
      const targetBloom =
        degradeLevel === 0 ? 1 : DEGRADE_STEPS[degradeLevel - 1].bloomScale;

      const nextCount = Math.round(
        (scene.shapeDefs ? 18000 : 18000) * targetScale
      );
      scene.setParticleCount(nextCount);
      scene.setBloomScale(targetBloom);
      console.info(`[perf] 帧率恢复(${fps.toFixed(0)})，回升到第 ${degradeLevel} 级`);
    }
  } else {
    // 中间区间：慢慢把计数器拉回中性，避免残留计数导致误判
    lowFpsStreak *= 0.85;
  }
}

/* ================================================================== *
 * 启动流程
 * ================================================================== */

/** 先建场景，让用户在授权对话框弹出时就能看到背景粒子 */
function bootScene() {
  scene = new FlowerScene(dom.canvas, cfg);
  return scene;
}

/* ================================================================== *
 * 模型预加载
 *
 * 页面一打开就在后台开始，不等用户点「开启摄像头」。
 *
 * 为什么必须这样：
 *   原来要等用户点击后才开始下载约 16 MB 的模型，
 *   而国内从 GitHub Pages 拉这个体积实测要 7 分钟（38 KB/s，
 *   并行时甚至掉到 3 KB/s），90 秒就超时放弃了 —— 永远进不去。
 *   改成后台预加载 + 实时进度后：
 *     · 用户看说明的这段时间就在下载
 *     · 界面上能看到"3.2 MB / 16.0 MB"，不再是死界面
 *     · 下载完经 Service Worker 落盘缓存，第二次打开是瞬间的
 * ================================================================== */

let preloadPromise = null;
/** 预加载结果，startGesture 会参考它来决定等待策略 */
const preloadState = { started: false, done: false, failed: false, cached: 0, bytes: 0 };

function startPreload() {
  if (preloadState.started) return preloadPromise;
  preloadState.started = true;

  const bar = dom.preloadBar?.firstElementChild;
  const text = dom.preloadText;
  if (dom.preload) dom.preload.hidden = false;
  if (bar) bar.style.width = '0%';
  if (text) text.innerHTML = '<span class="spinner"></span>正在加载手部识别模型…';

  preloadPromise = (async () => {
    try {
      // 先注册 Service Worker：它负责把资源缓存下来，并让下载可串行
      const reg = await registerServiceWorker();
      if (!reg) console.info('[main] Service Worker 不可用，改为普通预加载');

      const res = await preloadMediaPipe((p) => {
        const pct = p.totalBytes ? Math.min(100, (p.loadedBytes / p.totalBytes) * 100) : 0;
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (!text) return;
        if (p.done) return;
        text.textContent =
          `正在加载识别模型 ${p.index}/${p.total} · ` +
          `${formatMB(p.loadedBytes)} / ${formatMB(p.totalBytes)}`;
      });

      preloadState.done = true;
      preloadState.failed = !res.ok;
      preloadState.cached = res.cachedAfter;
      preloadState.servedFromCache = res.servedFromCache;
      preloadState.bytes = res.bytes;

      if (bar) bar.style.width = '100%';
      if (dom.preload) dom.preload.classList.add('done');
      if (text) {
        if (!res.ok) {
          text.textContent = '识别模型部分加载失败，开启摄像头时会自动重试';
        } else if (res.servedFromCache >= ASSET_COUNT) {
          text.textContent = `✓ 识别模型已就绪（${res.servedFromCache}/${ASSET_COUNT} 来自本地缓存，无需重新下载）`;
        } else if (res.cachedAfter >= ASSET_COUNT) {
          text.textContent = `✓ 识别模型已就绪（已缓存 ${res.cachedAfter}/${ASSET_COUNT}，下次打开更快）`;
        } else {
          text.textContent = '✓ 识别模型已就绪，可直接开启摄像头';
        }
      }
    } catch (err) {
      preloadState.done = true;
      preloadState.failed = true;
      console.info('[main] 预加载异常（不影响使用）：', err?.message || err);
      if (text) text.textContent = '模型预加载未完成，开启摄像头时会自动重试';
    }
    return preloadState;
  })();

  return preloadPromise;
}

/** 摄像头 + MediaPipe 全链路 */
async function startGesture() {
  dom.startBtn.disabled = true;
  setStatus('<span class="spinner"></span>正在请求摄像头权限…');

  tracker = tracker || new HandTracker(dom.video, dom.skeleton);

  try {
    await tracker.openCamera();
  } catch (err) {
    dom.startBtn.disabled = false;
    handleCameraError(err);
    return;
  }

  setStatus('<span class="spinner"></span>摄像头已就绪，正在加载手部识别模型…');

  // 预加载还没跑完的话，先把剩下的等完（并显示进度），
  // 这样 MediaPipe 自己去取文件时基本都是缓存命中，几乎瞬间完成。
  if (preloadPromise && !preloadState.done) {
    setStatus('<span class="spinner"></span>正在等待模型下载完成…');
    await preloadPromise;
  }

  try {
    await tracker.loadMediaPipe((msg) => setStatus(`<span class="spinner"></span>${msg}`));
  } catch (err) {
    dom.startBtn.disabled = false;
    setStatus(
      `手部识别模型加载失败（${err.message}）。请检查网络后重试，或使用自动演示模式。`,
      'error'
    );
    // 摄像头已经拿到了，但模型没加载成功：降级成「摄像头背景 + 呼吸动画」
    enterExperience({ withGesture: false });
    return;
  }

  // 关键：真正跑一帧推理，确认 WASM 没有 abort。
  // 只判断「模型加载成功」是不够的—— hands.js 加载完成后，
  // MediaPipe 还要再下载约 16MB 的 WASM 与模型数据。
  //
  // 超时从 90 秒放宽到 300 秒：预加载正常情况下已经把文件都缓存好了，
  // 这里会秒过；但如果用户在预加载完成前就点了按钮，或者缓存被清掉了，
  // 就需要给慢网络留足时间。原来的 90 秒会在国内网速下**必然失败**，
  // 用户看到的是"等待 90 秒后报错"，永远进不去。
  setStatus('<span class="spinner"></span>正在初始化识别引擎…');
  try {
    await tracker.probeOnce(300000, (waited) => {
      const secs = Math.round(waited / 1000);
      setStatus(
        `<span class="spinner"></span>正在初始化识别引擎…已等待 ${secs} 秒` +
          `（模型约 16MB，首次加载较慢，请保持网络畅通）`
      );
    });
  } catch (err) {
    console.error('[main] 识别引擎初始化失败：', err);
    dom.startBtn.disabled = false;
    setStatus(
      `识别引擎初始化失败：${err?.message || err}。` +
        `可点击「跳过摄像头」使用自动演示，或刷新页面重试。`,
      'error'
    );
    // 摄像头已就绪但引擎失败：至少把摄像头画面作为背景显示出来
    document.body.classList.add('cam-on');
    enterExperience({ withGesture: false });
    return;
  }

  setStatus('识别就绪 ✓ 握拳试试看', 'ok');
  document.body.classList.add('cam-on');
  enterExperience({ withGesture: true });

  // MediaPipe 的 send() 循环
  tracker.start();

  // 首帧有结果后再关闭遮罩，避免出现空白
  setTimeout(() => dom.overlay.classList.add('hidden'), 420);
}

/** 跳过摄像头，进入自动演示 */
function startAutoDemo() {
  state.autoDemo = true;
  dom.btnAuto.setAttribute('aria-pressed', 'true');
  setStatus('已进入自动演示模式');
  enterExperience({ withGesture: false });
  dom.overlay.classList.add('hidden');
}

/**
 * 进入体验态
 * @param {{withGesture:boolean}} opts
 */
function enterExperience({ withGesture }) {
  dom.overlay.classList.add('hidden');
  state.gestureActive = withGesture;

  if (withGesture) {
    dom.hint.innerHTML =
      '握拳 → <b>花苞</b>　　张开五指 → <b>绽放</b>　　' +
      '只伸食指 → 花瓣<b>跟指尖走</b>　　转手腕 → 花朵<b>旋转</b>　　' +
      '拇指食指捏合 → <b>缩放</b>　　快速挥手 → <b>吹散</b>';
  } else if (state.autoDemo) {
    dom.hint.innerHTML = '自动演示中　　点击右上角<b>自动演示</b>可停止，或刷新页面开启摄像头';
  } else {
    dom.hint.innerHTML = '未启用手势识别　　花朵正在自动呼吸，可刷新页面重试摄像头';
  }

  // 12 秒后淡出提示（内容变长了，留久一点）
  setTimeout(() => {
    dom.hint.style.opacity = '0.35';
  }, 12000);
}

/* ---------------- 摄像头错误分类提示 ---------------- */

function handleCameraError(err) {
  const code = err.code || 'UNKNOWN';
  const messages = {
    DENIED:
      '摄像头权限被拒绝。请在浏览器地址栏左侧的权限图标中允许摄像头，然后刷新页面重试。',
    NOT_FOUND: '未检测到摄像头设备，请连接摄像头后重试，或使用自动演示模式。',
    IN_USE: '摄像头被其他程序占用（如会议软件）。请关闭占用程序后重试。',
    INSECURE:
      '浏览器要求安全上下文才能访问摄像头。请通过 http://localhost 或 HTTPS 访问本页面。',
    NO_API: '当前浏览器不支持摄像头 API，建议使用 Chrome / Edge / Safari 最新版。',
    OVERCONSTRAINED: '摄像头不支持所请求的分辨率，请尝试更换设备。',
    UNKNOWN: `摄像头启动失败：${err.message}`,
  };
  setStatus(messages[code] || messages.UNKNOWN, 'error');

  // 失败时自动兜底到自动演示，保证用户仍能看到效果
  setTimeout(() => {
    if (!state.autoDemo && dom.overlay && !dom.overlay.classList.contains('hidden')) {
      startAutoDemo();
    }
  }, 2200);
}

function setStatus(html, kind = '') {
  dom.status.className = kind;
  dom.status.innerHTML = html;
}

/* ================================================================== *
 * 形态切换 UI
 * ================================================================== */

let shapeToastTimer = 0;

/** 依据 scene 里的形态定义生成按钮 */
function buildShapeUI() {
  if (!scene || !dom.shapeRow) return;

  dom.shapeRow.innerHTML = '';
  scene.shapeDefs.forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'shape-btn';
    btn.dataset.shape = def.id;
    btn.setAttribute('aria-pressed', String(def.id === scene.currentShape));
    btn.title = `${def.name} —— ${def.desc}（快捷键 ${i + 1}）`;
    btn.innerHTML = `<span class="ico">${def.icon}</span>${def.name}`;
    btn.addEventListener('click', () => selectShape(def.id));
    dom.shapeRow.appendChild(btn);
  });

  updateShapeUI();
}

function updateShapeUI() {
  if (!scene || !dom.shapeRow) return;
  const cur = scene.currentShape;
  for (const btn of dom.shapeRow.querySelectorAll('.shape-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.shape === cur));
  }
  const info = scene.getShapeInfo();
  dom.shapeCurrent.textContent = info.name;
}

/** 切换形态并给出反馈 */
function selectShape(id) {
  if (!scene) return;
  const changed = scene.setShape(id);
  updateShapeUI();
  if (changed) {
    const info = scene.getShapeInfo();
    showShapeToast(`${info.icon} ${info.name}`);
    // 变形时来一圈光环，强调「变身」这个瞬间
    scene.triggerScatter(0.35);
  }
}

function showShapeToast(text) {
  if (!dom.shapeToast) return;
  dom.shapeToast.textContent = text;
  dom.shapeToast.classList.add('show');
  clearTimeout(shapeToastTimer);
  shapeToastTimer = setTimeout(() => {
    dom.shapeToast.classList.remove('show');
  }, 1200);
}

/* ================================================================== *
 * 交互绑定
 * ================================================================== */

function bindUI() {
  dom.startBtn.addEventListener('click', startGesture);
  dom.skipBtn.addEventListener('click', startAutoDemo);

  // 摄像头画面开关
  dom.btnCam.addEventListener('click', () => {
    const on = document.body.classList.toggle('cam-on');
    dom.btnCam.setAttribute('aria-pressed', String(on));
  });

  // 关键点开关
  dom.btnSkel.addEventListener('click', () => {
    const on = document.body.classList.toggle('show-skeleton');
    dom.btnSkel.setAttribute('aria-pressed', String(on));
  });
  // 默认显示骨架
  document.body.classList.add('show-skeleton');

  // 自动演示开关
  dom.btnAuto.addEventListener('click', () => {
    state.autoDemo = !state.autoDemo;
    dom.btnAuto.setAttribute('aria-pressed', String(state.autoDemo));
    if (state.autoDemo || !state.gestureActive) {
      dom.hint.style.opacity = '1';
      setTimeout(() => (dom.hint.style.opacity = '0.35'), 4000);
    }
  });

  // 重置
  dom.btnReset.addEventListener('click', () => {
    scene?.reset();
    state.spread = 0;
  });

  // 空格：快速在花苞 / 绽放之间切换（调试与演示用）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      state.autoDemo = !state.autoDemo;
      dom.btnAuto.setAttribute('aria-pressed', String(state.autoDemo));
    }
    if (e.code === 'KeyC') {
      const on = document.body.classList.toggle('cam-on');
      dom.btnCam.setAttribute('aria-pressed', String(on));
    }
    if (e.code === 'KeyH') {
      const on = document.body.classList.toggle('show-skeleton');
      dom.btnSkel.setAttribute('aria-pressed', String(on));
    }
    if (e.code === 'KeyR') scene?.reset();

    // 数字键 1~6：切换形态
    const digitMatch = /^Digit([1-6])$/.exec(e.code);
    if (digitMatch && scene) {
      const idx = Number(digitMatch[1]) - 1;
      const def = scene.shapeDefs[idx];
      if (def) {
        e.preventDefault();
        selectShape(def.id);
      }
    }
    // Tab / 方向键：循环切换形态
    if (e.code === 'Tab' && scene) {
      e.preventDefault();
      selectShape(scene.cycleShape(e.shiftKey ? -1 : 1));
    }
    if (e.code === 'ArrowRight' && scene) selectShape(scene.cycleShape(1));
    if (e.code === 'ArrowLeft' && scene) selectShape(scene.cycleShape(-1));
  });

  // 响应式
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scene?.resize(), 90);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // 页面隐藏时暂停推理，省电
  document.addEventListener('visibilitychange', () => {
    if (!tracker) return;
    if (document.hidden) {
      tracker.running = false;
    } else if (state.gestureActive) {
      tracker.running = true;
      tracker.start();
    }
    lastTime = performance.now();
  });

  // 卸载时释放资源
  window.addEventListener('pagehide', () => {
    tracker?.dispose();
    scene?.dispose();
  });
}

/* ================================================================== *
 * 入口
 * ================================================================== */

function init() {
  bootScene();
  buildShapeUI();
  bindUI();
  requestAnimationFrame(loop);

  // 立刻在后台开始预加载模型（约 16MB）。
  // 不等用户点「开启摄像头」——用户看说明的时间就用来下载了。
  // 不 await：它和粒子动画并行跑，失败也不影响花朵显示。
  startPreload();

  // 调试钩子：控制台或自动化测试可读取实时内部状态
  window.__bloomDebug = () => ({
    spread: Number(state.spread.toFixed(4)),
    tension: Number(state.tension.toFixed(4)),
    targetSpread: Number(tensionToSpread(state.tension).toFixed(4)),
    fps: Number(state.fps.toFixed(1)),
    hand: [Number(state.handX.toFixed(3)), Number(state.handY.toFixed(3))],
    hasHand: state.hasHand,
    particles: scene?.particleCount ?? 0,
    bloom: !!scene?.useBloom,
    autoDemo: state.autoDemo,
    gestureActive: state.gestureActive,
    drawCalls: scene?.renderer?.info?.render?.calls ?? 0,
    programs: scene?.renderer?.info?.programs?.length ?? 0,
    shaderError: scene?.shaderError || null,
    shape: scene?.currentShape ?? null,
    // 模型预加载状态（用于自动化验证）
    preload: {
      started: preloadState.started,
      done: preloadState.done,
      failed: preloadState.failed,
      /** 本次有几个文件由 Service Worker 直接给了缓存 */
      servedFromCache: preloadState.servedFromCache ?? 0,
      /** 缓存里现在有几个文件 */
      cachedInStorage: preloadState.cached ?? 0,
      bytes: preloadState.bytes,
      swController: !!navigator.serviceWorker?.controller,
    },
    morph: scene ? Number(scene._morph.toFixed(3)) : null,
  });

  // 供测试驱动：直接设置张力（null 表示恢复正常输入）
  window.__bloomSetTension = (v) => {
    state.tensionOverride = v === null ? null : Math.max(0, Math.min(1, v));
  };
  // 立即把缓动推到目标值，跳过收敛等待
  window.__bloomSnap = () => {
    state.spread = tensionToSpread(state.tension);
    return state.spread;
  };
  // 暴露 tracker / scene，便于控制台排查（F12 里可直接查看）
  window.__bloomTracker = null;
  window.__bloomExposeTracker = () => {
    window.__bloomTracker = tracker;
    return !!tracker;
  };
  window.__bloomExposeScene = () => scene;
  /** 打印当前识别状态，供用户在控制台自查 */
  window.__bloomStatus = () => {
    if (!tracker) return '未启用摄像头（自动演示模式）';
    return {
      服务器来源: tracker.sourceHost || '(未加载)',
      模型就绪: tracker.ready,
      推理循环: tracker.running,
      检测到手: tracker.hasHand,
      tension: Number(tracker.tension.toFixed(4)),
      关键点数: tracker.landmarks ? tracker.landmarks.length : 0,
      send失败次数: tracker.sendErrors || 0,
      最后错误: tracker.lastSendError ? String(tracker.lastSendError) : null,
    };
  };

  // 提前探测能力，给出更精确的提示
  if (!window.isSecureContext) {
    setStatus(
      '提示：当前非安全上下文，浏览器会阻止摄像头访问。请用 http://localhost 或 HTTPS 打开。',
      'error'
    );
  } else if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('提示：当前浏览器不支持摄像头 API，可使用下方的自动演示模式。', 'error');
  }
}

init();