/**
 * handTracking.js —— MediaPipe Hands 封装
 *
 * 职责：
 *   1. 打开摄像头（含权限错误分类处理）
 *   2. 驱动 MediaPipe Hands，输出 21 个关键点
 *   3. 由关键点计算 tension（手掌张开度，0~1）并做平滑
 *   4. 输出归一化后的手掌中心位置，供粒子跟随
 *
 * 21 点索引（MediaPipe 约定）：
 *   0  WRIST
 *   1  THUMB_CMC      2  THUMB_MCP      3  THUMB_IP       4  THUMB_TIP
 *   5  INDEX_MCP      6  INDEX_PIP      7  INDEX_DIP      8  INDEX_TIP
 *   9  MIDDLE_MCP    10  MIDDLE_PIP    11  MIDDLE_DIP    12  MIDDLE_TIP
 *  13  RING_MCP      14  RING_PIP      15  RING_DIP      16  RING_TIP
 *  17  PINKY_MCP     18  PINKY_PIP     19  PINKY_DIP     20  PINKY_TIP
 */

import { CONFIG } from './config.js';
import { GestureTracker } from './gestures.js';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 五个指尖 */
const TIPS = [4, 8, 12, 16, 20];
/** 五根手指的 MCP（掌指关节，即手指根部） */
const MCPS = [1, 5, 9, 13, 17];
/** 五根手指的 PIP（近端指间关节） */
const PIPS = [2, 6, 10, 14, 18];

/** 手掌骨架连线，用于绘制关键点 */
export const HAND_CONNECTIONS = [
  // 拇指
  [0, 1], [1, 2], [2, 3], [3, 4],
  // 食指
  [0, 5], [5, 6], [6, 7], [7, 8],
  // 中指
  [9, 10], [10, 11], [11, 12], [5, 9],
  // 无名指
  [13, 14], [14, 15], [15, 16], [9, 13],
  // 小指
  [17, 18], [18, 19], [19, 20], [13, 17],
  // 掌根闭合
  [0, 17],
];

/* ------------------------------------------------------------------ *
 * 几何工具
 * ------------------------------------------------------------------ */

/** 两点欧氏距离 */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 三维向量夹角（返回弧度） */
function angleBetween(a, b, c) {
  // 顶点为 b
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  // 夹紧到 [-1,1] 防止浮点误差导致 NaN
  return Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2))));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 把 v 从 [inMin,inMax] 线性映射到 [0,1] 并夹紧 */
function normalizeRange(v, inMin, inMax) {
  return clamp01((v - inMin) / (inMax - inMin));
}

/* ------------------------------------------------------------------ *
 * tension 核心算法
 * ------------------------------------------------------------------ */

/**
 * 计算手掌张开度 tension ∈ [0,1]
 *
 * 采用三个互补特征加权融合，比单一指标稳健得多：
 *
 *  ── 特征 A：指尖 / 指根 距离比（主特征，权重 0.5）
 *      d_tip  = Σ|wrist → tip_i|     （5 个指尖到手腕的距离之和）
 *      d_mcp  = Σ|wrist → mcp_i|     （5 个指根到手腕的距离之和）
 *      A_raw  = d_tip / d_mcp
 *      实测：握拳 ≈ 1.29，完全张开 ≈ 3.45
 *      A = normalizeRange(A_raw, 1.20, 2.60)
 *
 *      归一化区间要覆盖「从完全握拳到接近伸直」的整个范围。
 *      区间取得过窄（例如 [1.05,1.85]）会让手指刚松开一点就饱和成 1，
 *      手势就退化成开关而不是连续渐变。
 *
 *  ── 特征 B：手指伸展度（权重 0.3）
 *      对每根手指算「腕→根→尖」的夹角 θ_i（伸直 ≈ π，弯曲 ≈ 0.6π）
 *      再乘以「指尖超出指根的长度」作为权重，避免短指干扰。
 *      B = Σ w_i · normalizeRange(θ_i, 1.20, 3.00) / Σ w_i
 *      其中 w_i = |wrist→tip_i| / d_tip
 *
 *  ── 特征 C：手指伸展的一致性（权重 0.2）
 *      用「各指尖到掌心距离」的变异系数 cv = σ/μ 衡量：
 *        · 五指一起张开时各指尖距离接近 → cv 小 → C 大
 *        · 只伸出一两根手指时距离差异大 → cv 大 → C 小
 *      C = 1 - normalizeRange(cv, 0.10, 0.62)
 *
 *  tension_raw = 0.5·A + 0.3·B + 0.2·C
 *  再做一次 S 形拉伸，让中间过渡更快、两端更稳：
 *  tension = smoothstep(0, 1, tension_raw)
 *
 * 最后用指数平滑抑制抖动：
 *   smoothed += (tension - smoothed) * smoothing
 *
 * @param {Array<{x:number,y:number,z:number}>} lm 21 个关键点
 * @returns {{tension:number, features:{A:number,B:number,C:number}}}
 */
export function computeTension(lm) {
  const wrist = lm[0];

  // ---- 特征 A：指尖 / 指根 距离比 ----
  let dTip = 0;
  for (const i of TIPS) dTip += dist(wrist, lm[i]);
  let dMcp = 0;
  for (const i of MCPS) dMcp += dist(wrist, lm[i]);
  if (dMcp < 1e-6) dMcp = 1e-6;
  const aRaw = dTip / dMcp;
  // 实测：握拳 ≈ 1.29，完全张开 ≈ 3.45（五指长度权重之和的最大值约 3.5）。
  // 区间必须覆盖这个真实范围，否则 openness≈0.4 就饱和成 1，
  // 手势会退化成「开关」而不是连续渐变。
  const A = normalizeRange(aRaw, 1.20, 2.60);

  // ---- 特征 B：手指伸展度（带长度权重）----
  let bSum = 0;
  let bWeight = 0;
  for (let f = 0; f < 5; f++) {
    const mcp = lm[MCPS[f]];
    const pip = lm[PIPS[f]];
    const tip = lm[TIPS[f]];
    // 用 腕→根→尖 的夹角衡量整根手指伸展程度
    const theta = angleBetween(wrist, mcp, tip);
    // PIP 处的弯曲也会拉低伸展度，取两者较小值更灵敏
    const thetaPip = angleBetween(mcp, pip, tip);
    const straight = Math.min(theta, thetaPip + 0.35);
    const w = dist(wrist, tip) / (dTip > 1e-6 ? dTip : 1e-6);
    bSum += w * normalizeRange(straight, 1.20, 3.00);
    bWeight += w;
  }
  const B = bWeight > 1e-6 ? clamp01(bSum / bWeight) : 0;

  // ---- 特征 C：手指伸展的「一致性」----
  // 早期版本用「指尖包围盒对角线 / 掌宽」，实测这个量恒在 2~5 之间、
  // 且在握拳时就已经饱和（因为食指↔小指的指根跨度本身就撑开了包围盒），
  // 等于一个常数，白白浪费 20% 权重。
  //
  // 改用「指尖到掌心距离的标准差 / 均值」的补数：
  //   · 五指张开时，各指尖到掌心距离相近 → 离散度小 → C 大
  //   · 只有一两根手指伸出时，距离差异很大 → 离散度大 → C 小
  // 这样 C 才真正表达「是不是整只手都在张开」。
  const palm = lm[9]; // 中指 MCP，作为掌心参考点
  const tipDists = TIPS.map((i) => dist(palm, lm[i]));
  const meanTip = tipDists.reduce((s, v) => s + v, 0) / tipDists.length;
  let variance = 0;
  for (const v of tipDists) variance += (v - meanTip) * (v - meanTip);
  variance /= tipDists.length;
  const cv = meanTip > 1e-6 ? Math.sqrt(variance) / meanTip : 0; // 变异系数
  // cv 越小越一致（整只手张开），越大越不一致（只伸了一两根手指）
  const C = 1 - normalizeRange(cv, 0.10, 0.62);

  // ---- 融合 ----
  const raw = 0.5 * A + 0.3 * B + 0.2 * C;
  // smoothstep 让 0.32 / 0.66 两个阈值附近的过渡更自然
  const tension = raw * raw * (3 - 2 * raw);

  return { tension: clamp01(tension), features: { A, B, C, raw } };
}

/* ------------------------------------------------------------------ *
 * 张开度 → 绽放程度 的映射与缓动
 * ------------------------------------------------------------------ */

/**
 * 把 tension 映射为 targetSpread ∈ [0,1]
 *   tension < 0.32  → 0   （完全闭合的花苞）
 *   tension > 0.66  → 1   （完全绽放）
 *   中间用 smoothstep 平滑过渡
 */
export function tensionToSpread(tension, cfg = CONFIG.gesture) {
  const t = normalizeRange(
    tension,
    cfg.budThreshold,
    cfg.bloomThreshold
  );
  // 过渡区间内再做一次 smoothstep，避免线性带来的“机械感”
  return t * t * (3 - 2 * t);
}

/** 当前状态名，用于 UI 显示 */
export function spreadStateName(spread) {
  if (spread < 0.06) return '花苞 · 闭合';
  if (spread < 0.34) return '初绽 · 微开';
  if (spread < 0.72) return '盛放中 · 半开';
  if (spread < 0.96) return '绽放 · 全开';
  return '怒放 · 极盛';
}

/* ------------------------------------------------------------------ *
 * HandTracker 类
 * ------------------------------------------------------------------ */

export class HandTracker {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} skeletonCanvas
   */
  constructor(videoEl, skeletonCanvas) {
    this.video = videoEl;
    this.skeleton = skeletonCanvas;
    this.ctx = skeletonCanvas.getContext('2d');

    this.hands = null;
    this.stream = null;
    this.running = false;
    this.ready = false;

    /** 平滑后的 tension */
    this.tension = 0;
    /** 上一帧是否检测到手 */
    this.hasHand = false;
    /** 当前 21 点（归一化坐标，已按镜像修正） */
    this.landmarks = null;
    /** 平滑后的手掌中心，范围 [-0.5, 0.5]，镜像后：右为正 */
    this.center = { x: 0, y: 0 };
    this.targetCenter = { x: 0, y: 0 };
    /** 手势朝向：手腕 → 中指 MCP 的方向，用于让花朵跟随手掌倾斜 */
    this.orientation = { x: 0, y: 0 };

    /**
     * 扩展手势信号（指尖位置 / 旋转 / 捏合 / 挥手…）。
     * tension 只表达「张开度」，这些额外信号由 gestures.js 提取，
     * 用于驱动更多动作（单指追踪、旋转、缩放等）。
     */
    this.gestures = new GestureTracker();
    /** 最近一帧的骨骼数据时间戳，供平滑使用 */
    this._lastLmTime = 0;

    this._onResults = this._onResults.bind(this);
    this._rafId = 0;
  }

  /* ---------------- 摄像头 ---------------- */

  /**
   * 打开摄像头。抛出的 Error 带 .code 字段，便于 UI 分类提示：
   *   NO_API | INSECURE | DENIED | NOT_FOUND | IN_USE | OVERCONSTRAINED | UNKNOWN
   */
  async openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('当前浏览器不支持 getUserMedia');
      err.code = 'NO_API';
      throw err;
    }
    // 非安全上下文（http:// 且非 localhost）下 getUserMedia 不可用
    if (!window.isSecureContext) {
      const err = new Error('需要 HTTPS 或 localhost 安全上下文');
      err.code = 'INSECURE';
      throw err;
    }

    const constraints = {
      audio: false,
      video: {
        facingMode: CONFIG.camera.facingMode,
        width: CONFIG.camera.width,
        height: CONFIG.camera.height,
      },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // 理想分辨率可能不被支持，退化为默认约束重试一次
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        } catch (e2) {
          throw this._classifyError(e2);
        }
      } else {
        throw this._classifyError(e);
      }
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;

    await new Promise((resolve, reject) => {
      const done = () => resolve();
      if (this.video.readyState >= 2) return done();
      this.video.onloadedmetadata = done;
      setTimeout(done, 6000);
      this.video.onerror = () => reject(new Error('视频元素加载失败'));
    });

    try {
      await this.video.play();
    } catch {
      /* 某些浏览器自动播放策略下会抛错，忽略即可，画面仍可用 */
    }

    return stream;
  }

  _classifyError(e) {
    const name = e && e.name ? e.name : 'UnknownError';
    const map = {
      NotAllowedError: ['DENIED', '摄像头权限被拒绝'],
      PermissionDeniedError: ['DENIED', '摄像头权限被拒绝'],
      NotFoundError: ['NOT_FOUND', '未检测到可用摄像头'],
      DevicesNotFoundError: ['NOT_FOUND', '未检测到可用摄像头'],
      NotReadableError: ['IN_USE', '摄像头被其他程序占用'],
      TrackStartError: ['IN_USE', '摄像头被其他程序占用'],
      OverconstrainedError: ['OVERCONSTRAINED', '摄像头不支持请求的分辨率'],
      SecurityError: ['INSECURE', '安全策略阻止了摄像头访问'],
      AbortError: ['UNKNOWN', '摄像头启动被中断'],
    };
    const [code, msg] = map[name] || ['UNKNOWN', `摄像头错误：${name}`];
    const err = new Error(msg);
    err.code = code;
    err.original = e;
    return err;
  }

  /* ---------------- MediaPipe ---------------- */

  /**
   * 动态加载 MediaPipe Hands（CDN），避免把大依赖打进 bundle，
   * 也让「跳过摄像头」路径完全不需要下载模型。
   *
   * 由于 hands.js 既可能是 ESM 也可能注册全局 window.Hands，
   * 且不同 CDN 可达性差异很大（实测部分网络下 jsdelivr 会超时），
   * 这里按 scriptUrls 顺序逐个尝试：
   *   1. 先试动态 import()（ESM 路径）
   *   2. 失败则退回 <script> 标签注入（UMD 路径），读取 window.Hands
   */
  async loadMediaPipe(onProgress) {
    if (this.hands) return this.hands;

    const { scriptUrls, assetBases } = CONFIG.mediapipe;
    let lastErr = null;

    for (let i = 0; i < scriptUrls.length; i++) {
      const url = scriptUrls[i];
      // 相对路径（本地资源）必须以页面为基准解析成绝对地址，
      // MediaPipe 内部会用它去推 locateFile 的相对关系。
      const absUrl = new URL(url, location.href).href;
      const absBase = new URL(assetBases[i] || assetBases[0], location.href).href;

      let host;
      try {
        host = new URL(absUrl).host || 'localhost';
      } catch {
        host = 'local';
      }
      const isLocal = absUrl.startsWith(location.origin);

      try {
        onProgress?.(
          isLocal
            ? '正在加载手部识别模型（本地）…'
            : `正在加载手部识别模型（${host}）…`
        );
        const HandsCtor = await this._loadHandsCtor(absUrl);
        if (!HandsCtor) throw new Error('脚本已加载但未找到 Hands 构造函数');

        // 资源基址与脚本来源保持一致，避免跨源版本错配
        CONFIG.mediapipe.activeBase = absBase;

        /* locateFile 的正确用法（这里很容易踩坑）：
         *
         * MediaPipe 会先算出路径
         *   third_party/mediapipe/modules/hand_landmark/hand_landmark_full.tflite
         * 再调用 overrideFile() 用「打包资源」hands_solution_packed_assets.data
         * 里解出来的同名文件覆盖它。也就是说模型文件本该来自打包资源，
         * 并不需要单独下载。
         *
         * 如果我们对**所有**文件名都返回 `${base}${file}`，
         * 那个 .tflite 就会被当成外部文件去请求（404 或拿到错误的文件），
         * 于是报 "Model provided has model identifier 'Not ', should be 'TFL3'"
         * 或者 "No subgraph in the model"，最终 WASM abort。
         *
         * 所以这里只接管「确实需要从外部取」的文件：
         * wasm / loader / data 包 / binarypb 图定义。
         * 其余（尤其 .tflite）返回 undefined，交回 MediaPipe 的打包资源处理。
         */
        const EXTERNAL_RE = CONFIG.mediapipe.externalFilePattern;

        const hands = new HandsCtor({
          locateFile: (file) => {
            if (/^https?:\/\//i.test(file)) return file;
            // 不能返回 undefined —— MediaPipe 会拿返回值直接拼 URL，
            // undefined 会变成请求 "/undefined"。
            if (!EXTERNAL_RE.test(file)) return file;
            return `${absBase}${file}`;
          },
        });
        hands.setOptions({
          maxNumHands: CONFIG.mediapipe.maxNumHands,
          modelComplexity: 1,
          minDetectionConfidence: CONFIG.mediapipe.minDetectionConfidence,
          minTrackingConfidence: CONFIG.mediapipe.minTrackingConfidence,
          selfieMode: false, // 我们自己处理镜像，避免双重翻转
        });
        hands.onResults(this._onResults);

        this.hands = hands;
        this.ready = true;
        this.sourceHost = host;
        console.info(`[hands] 模型已从 ${host} 加载`);
        return hands;
      } catch (e) {
        lastErr = e;
        console.warn(`[hands] 从 ${host} 加载失败，尝试下一个源：`, e?.message || e);
      }
    }

    throw new Error(
      `所有 CDN 均无法加载手部识别模型（${lastErr?.message || '未知错误'}）`
    );
  }

  /** 尝试用两种方式拿到 Hands 构造函数 */
  async _loadHandsCtor(url) {
    // 方式一：动态 import（hands.js 是 UMD，import 后会挂到 window 上）
    try {
      const mod = await import(/* @vite-ignore */ url);
      const ctor = mod?.Hands || mod?.default?.Hands || window.Hands;
      if (ctor) return ctor;
    } catch {
      /* 落到方式二 */
    }

    // 方式二：<script> 注入，等待 onload
    if (window.Hands) return window.Hands;

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-hands-src="${url}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error('脚本加载失败')), {
          once: true,
        });
        return;
      }
      const s = document.createElement('script');
      s.src = url;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.dataset.handsSrc = url;
      const timer = setTimeout(() => reject(new Error('脚本加载超时')), 25000);
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('脚本加载失败'));
      };
      document.head.appendChild(s);
    });

    return window.Hands || null;
  }

  /** 启动推理循环 */
  async start() {
    if (!this.hands) await this.loadMediaPipe();
    this.running = true;
    this._loop();
  }

  _loop = () => {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._loop);
    if (this.video.readyState < 2) return;

    // send() 内部有节流，重复调用是安全的。
    // 注意：这里必须把错误记录下来，不能静默吞掉——
    // 否则 MediaPipe 初始化失败（例如 WASM abort）时，
    // UI 会一直显示「识别就绪」，用户却什么都看不到。
    this.hands
      ?.send({ image: this.video })
      .then(() => {
        this._sentOk = true;
      })
      .catch((err) => {
        this.sendErrors = (this.sendErrors || 0) + 1;
        this.lastSendError = err;
        // 只在前几次打日志，避免每帧刷屏
        if (this.sendErrors <= 3) {
          console.error('[hands] send() 失败：', err);
        }
        // 连续失败说明模型没有真正跑起来，通知上层
        if (this.sendErrors === 5 && typeof this.onFatal === 'function') {
          this.onFatal(err);
        }
      });
  };

  /**
   * 发送一帧并等待推理结果，用于确认模型是否真的工作。
   *
   * 这一步很关键：hands.js 加载完成 ≠ 能用。
   * MediaPipe 还要再下载 ~6MB 的 WASM 与 ~4MB 的模型数据
   * （实测慢网络下单是 WASM 就要 40+ 秒），
   * 如果这里不等待、不报错，用户会看到「摄像头灯亮了但毫无反应」。
   *
   * @param {number} timeoutMs 超时时间，超时即判定为失败
   * @param {(waited:number)=>void} onWait 等待中的回调，用于刷新进度提示
   */
  async probeOnce(timeoutMs = 30000, onWait) {
    if (!this.hands) throw new Error('模型未加载');
    if (this.video.readyState < 2) throw new Error('视频尚未就绪');

    const started = Date.now();
    let settled = false;

    // 进度心跳：每秒告诉上层还在等
    const heartbeat = setInterval(() => {
      if (!settled) onWait?.(Date.now() - started);
    }, 1000);

    try {
      const sendPromise = this.hands
        .send({ image: this.video })
        .then(() => 'ok')
        .catch((e) => ({ err: e }));

      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve('timeout'), timeoutMs)
      );

      const outcome = await Promise.race([sendPromise, timeoutPromise]);

      if (outcome === 'timeout') {
        throw new Error(
          `识别引擎初始化超时（已等待 ${Math.round((Date.now() - started) / 1000)} 秒）。` +
            `模型约需下载 10MB，请检查网络后重试`
        );
      }
      if (outcome && outcome.err) throw outcome.err;
      return true;
    } finally {
      settled = true;
      clearInterval(heartbeat);
    }
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
  }

  /* ---------------- 结果回调 ---------------- */

  _onResults(results) {
    // 记录原始结果，便于排查「模型跑了但检测不到手」这类问题
    this.lastResultKeys = results ? Object.keys(results) : null;
    this.lastLandmarkCount =
      results?.multiHandLandmarks?.length
        ? results.multiHandLandmarks[0].length
        : 0;

    // 镜像修正：摄像头画面是镜像显示的，x 用 1-x 让坐标与视觉一致
    const raw = results.multiHandLandmarks && results.multiHandLandmarks[0];

    // MediaPipe 的回调频率与渲染帧率不同，这里按真实时间差推进手势平滑，
    // 否则在 20Hz 推理 + 60Hz 渲染时会平滑过度、手感发黏。
    const now = performance.now() / 1000;
    const dtLm = this._lastLmTime ? Math.min(now - this._lastLmTime, 0.2) : 1 / 30;
    this._lastLmTime = now;

    if (raw && raw.length >= 21) {
      const lm = raw.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z || 0 }));
      this.landmarks = lm;
      this.hasHand = true;

      const { tension } = computeTension(lm);
      const s = CONFIG.gesture.smoothing;
      this.tension += (tension - this.tension) * s;

      // 手掌中心 = 掌心(9) 与手腕(0) 的中点，比用全部点更稳定
      const cx = (lm[9].x + lm[0].x) * 0.5;
      const cy = (lm[9].y + lm[0].y) * 0.5;
      this.targetCenter.x = (cx - 0.5) * 2;  // → [-1,1]
      this.targetCenter.y = (cy - 0.5) * 2;  // → [-1,1]（y 向下）

      // 朝向：手腕 → 中指 MCP
      this.orientation.x = lm[9].x - lm[0].x;
      this.orientation.y = lm[9].y - lm[0].y;

      // 扩展手势信号（指尖位置 / 旋转 / 捏合 / 挥手）
      this.gestures.update(lm, dtLm);
    } else {
      this.hasHand = false;
      this.landmarks = null;
      // 手离开画面时缓慢回落，避免花朵突然跳动
      this.tension += (0 - this.tension) * CONFIG.gesture.lostDecay;
      this.targetCenter.x *= 0.98;
      this.targetCenter.y *= 0.98;
      this.gestures.update(null, dtLm);
    }
  }

  /** 每帧调用：推进平滑并绘制骨架 */
  update(dtScale) {
    const k = 1 - Math.pow(1 - CONFIG.gesture.positionSmoothing, dtScale);
    this.center.x += (this.targetCenter.x - this.center.x) * k;
    this.center.y += (this.targetCenter.y - this.center.y) * k;
    this.drawSkeleton();
  }

  /* ---------------- 关键点绘制 ---------------- */

  drawSkeleton() {
    const canvas = this.skeleton;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lm = this.landmarks;
    if (!lm) return;

    // 坐标已是镜像后的归一化值，直接映射到屏幕
    // 但视频是 object-fit: cover，需要按同样的规则做 cover 映射
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (w - dw) / 2;
    const oy = (h - dh) / 2;

    const px = (p) => ({ x: ox + p.x * dw, y: oy + p.y * dh });

    // 连线
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(154,217,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,214,240,0.85)');
    grad.addColorStop(1, 'rgba(255,233,168,0.85)');
    ctx.strokeStyle = grad;
    ctx.shadowColor = 'rgba(154,217,255,0.9)';
    ctx.shadowBlur = 10;

    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = px(lm[a]);
      const pb = px(lm[b]);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // 关节点
    ctx.shadowBlur = 14;
    for (let i = 0; i < 21; i++) {
      const p = px(lm[i]);
      const isTip = TIPS.includes(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, isTip ? 4.6 : 2.8, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? '#ffe9a8' : 'rgba(255,255,255,0.92)';
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 张力环：以掌心为中心画一个随 tension 扩张的圆，直观反馈
    const c = px({ x: (lm[9].x + lm[0].x) * 0.5, y: (lm[9].y + lm[0].y) * 0.5 });
    const r = 26 + this.tension * 62;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,214,240,${0.18 + this.tension * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** 释放资源（含 MediaPipe WASM 句柄） */
  dispose() {
    this.stop();
    try {
      this.hands?.close?.();
    } catch {
      /* ignore */
    }
    this.hands = null;
    this.ready = false;
  }
}