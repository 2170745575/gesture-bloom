/**
 * gestures.js —— 手势动作识别
 *
 * handTracking.js 负责「算出 tension」这一件事；
 * 这里负责从 21 个关键点里提取**更多可用的动作信号**，供特效驱动：
 *
 *   1. 单指追踪     extendFingers / indexTip —— 哪几根手指伸着、食指尖在哪
 *   2. 手指旋转     rotation / rotationSpeed —— 手腕→中指方向的角度与角速度
 *   3. 捏合缩放     pinch —— 拇指与食指尖距离，控制整体缩放
 *   4. 挥手         wave —— 水平速度的累积，触发飘落/散开
 *   5. 手掌远近     depth —— 手的像素尺度，控制景深/缩放
 *
 * 设计原则：所有信号都做**归一化 + 平滑**，且对尺度不敏感
 * （用手掌宽度做基准），这样手离镜头远近不会误触发。
 */

/* ------------------------------------------------------------------ *
 * 关键点索引
 * ------------------------------------------------------------------ */

/** 指尖 */
export const TIPS = [4, 8, 12, 16, 20];
/** 指根（MCP） */
export const MCPS = [1, 5, 9, 13, 17];
/** 近端指间关节（PIP） */
export const PIPS = [2, 6, 10, 14, 18];

export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const FINGER_LABELS = ['拇指', '食指', '中指', '无名指', '小指'];

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleBetween2(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  const dot = (v1x * v2x + v1y * v2y) / (m1 * m2);
  return Math.acos(clamp(dot, -1, 1));
}

/* ------------------------------------------------------------------ *
 * 单帧手势特征提取（无状态）
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{x,y,z}>} lm 21 个关键点（已镜像修正）
 * @returns 手势特征
 */
export function extractHandFeatures(lm) {
  const wrist = lm[0];
  const middleMcp = lm[9];
  const indexMcp = lm[5];
  const pinkyMcp = lm[17];

  // 手掌宽度：作为所有长度量的归一化基准（尺度无关）
  const palmWidth = Math.max(dist2(indexMcp, pinkyMcp), 1e-6);
  // 手掌长度：腕 → 中指根
  const palmLength = Math.max(dist2(wrist, middleMcp), 1e-6);

  /* ---------- 1. 每根手指是否伸出 ---------- */
  const extendFingers = [false, false, false, false, false];
  const fingerCurl = [0, 0, 0, 0, 0]; // 0=伸直, 1=完全卷曲

  for (let f = 0; f < 5; f++) {
    const mcp = lm[MCPS[f]];
    const pip = lm[PIPS[f]];
    const tip = lm[TIPS[f]];

    // 手腕→根→尖 的夹角：伸直接近 π
    const theta = angleBetween2(wrist, mcp, tip);
    // 指根→PIP→尖 的夹角：更灵敏地反映弯曲
    const thetaPip = angleBetween2(mcp, pip, tip);
    const straight = Math.min(theta, thetaPip + 0.35);

    // 映射到 [0,1]：1 = 完全伸直（伸直时 straight ≈ 2.9，弯曲时 ≈ 1.2）
    const ext = clamp01((straight - 1.15) / (2.85 - 1.15));
    fingerCurl[f] = 1 - ext;

    // 拇指用另一套判据：它朝侧面张开，角度判据不可靠，
    // 改用「指尖到食指根的距离 / 掌宽」。
    // 实测该比值：张开 ≈ 0.47，握起 ≈ 0.34 —— 区间必须按实测标定，
    // 用 0.62 作阈值会导致拇指**永远**判定为未伸出。
    if (f === 0) {
      const thumbSpread = dist2(tip, indexMcp) / palmWidth;
      extendFingers[f] = thumbSpread > 0.42;
      fingerCurl[f] = 1 - clamp01((thumbSpread - 0.34) / (0.47 - 0.34));
    } else {
      // 其余四指用「相对自身指长的伸展度」判定，而不是各自独立的固定阈值。
      //
      // 原因：手指越短，握起来时「腕→根→尖」的夹角就越难变小。
      // 实测握拳时各指 straight 值：食指 1.45、中指 1.71、无名指 1.95、小指 2.22，
      // 小指明显偏大。若四指共用 0.55 的阈值，小指在握拳时会被误判为伸出。
      //
      // 这里按指长做归一化修正：短指需要更「直」才算伸出。
      const fingerLen = dist2(mcp, tip) / palmLength; // 相对掌长的指长
      // 指长越短，阈值越高（0.55 ~ 0.78）
      const thresh = 0.55 + clamp01((0.62 - fingerLen) / 0.42) * 0.23;
      extendFingers[f] = ext > thresh;
    }
  }

  /* ---------- 2. 指尖位置（归一化到掌心坐标系） ---------- */
  const palm = {
    x: (wrist.x + middleMcp.x) * 0.5,
    y: (wrist.y + middleMcp.y) * 0.5,
  };

  // 食指尖相对于掌心的位置，用手掌长度归一化
  const indexTip = {
    x: (lm[8].x - palm.x) / palmLength,
    y: (lm[8].y - palm.y) / palmLength,
  };
  // 输出到 [-1,1] 区间（超出会夹紧）
  const fingerPos = {
    x: clamp(indexTip.x, -1.5, 1.5),
    y: clamp(indexTip.y, -1.5, 1.5),
  };

  /* ---------- 3. 旋转角 ---------- */
  // 手腕 → 中指根 的方向角。手掌转动时这个角跟着转。
  const dx = middleMcp.x - wrist.x;
  const dy = middleMcp.y - wrist.y;
  const rotation = Math.atan2(dy, dx);

  /* ---------- 4. 捏合 ---------- */
  // 拇指尖 ↔ 食指尖 距离 / 掌宽。
  // 实测比值：完全张开 ≈ 0.92，完全捏合 ≈ 0.07。
  //
  // 约定：pinch = 1 表示「手指张开」，= 0 表示「捏紧」。
  // 用「张开」为正方向更好理解，也便于直接当作缩放系数使用。
  const pinchRaw = dist2(lm[4], lm[8]) / palmWidth;
  const pinch = clamp01((pinchRaw - 0.15) / (0.85 - 0.15));

  /* ---------- 5. 手掌远近 ---------- */
  // 手掌在画面中的实际尺度（用画面高度做基准）
  const depth = clamp01((palmLength - 0.06) / (0.30 - 0.06));

  /* ---------- 6. 伸出的手指数 ---------- */
  const extendedCount = extendFingers.filter(Boolean).length;

  return {
    palm,
    palmWidth,
    palmLength,
    extendFingers,
    fingerCurl,
    extendedCount,
    fingerPos,
    /** 食指是否单独伸出（其余手指都卷着）——用于「单指抽出花瓣」 */
    indexOnly: extendFingers[1] && !extendFingers[2] && !extendFingers[3] && !extendFingers[4],
    rotation,
    pinch,
    depth,
    /** 原始（未平滑）量，供上层做平滑 */
    raw: { fingerPos, rotation, pinch, depth, extendedCount },
  };
}

/* ------------------------------------------------------------------ *
 * 有状态的手势跟踪器：负责平滑与速度计算
 * ------------------------------------------------------------------ */

export class GestureTracker {
  constructor() {
    this.reset();
  }

  reset() {
    /** 平滑后的特征 */
    this.state = {
      fingerPos: { x: 0, y: 0 },
      rotation: 0,
      /** 累积旋转角（不取模，可以连续转很多圈） */
      rotationAccum: 0,
      rotationSpeed: 0,
      pinch: 0,
      depth: 0.5,
      extendedCount: 0,
      indexOnly: false,
      /** 挥手强度 [0,1] */
      wave: 0,
    };
    this._prevRotation = null;
    this._prevPalm = null;
    this._prevPinch = null;
    this._time = 0;
    this.hasHand = false;
  }

  /**
   * 每帧调用
   * @param {Array} lm 21 个关键点；传 null 表示本帧没检测到手
   * @param {number} dt 秒
   */
  update(lm, dt) {
    if (!lm) {
      this.hasHand = false;
      // 手离开画面：所有信号平滑归零
      const k = 1 - Math.pow(0.94, dt * 60);
      this.state.fingerPos.x = lerp(this.state.fingerPos.x, 0, k);
      this.state.fingerPos.y = lerp(this.state.fingerPos.y, 0, k);
      this.state.pinch = lerp(this.state.pinch, 0, k);
      this.state.wave = lerp(this.state.wave, 0, k);
      this.state.indexOnly = false;
      this.state.extendedCount = 0;
      this._prevRotation = null;
      this._prevPalm = null;
      this._prevPinch = null;
      return this.state;
    }

    this.hasHand = true;
    const f = extractHandFeatures(lm);

    // 平滑系数（按帧率归一化）
    const kPos = 1 - Math.pow(1 - 0.22, dt * 60);
    const kRot = 1 - Math.pow(1 - 0.18, dt * 60);
    const kOther = 1 - Math.pow(1 - 0.15, dt * 60);

    /* ---------- 指尖位置 ---------- */
    this.state.fingerPos.x = lerp(this.state.fingerPos.x, f.fingerPos.x, kPos);
    this.state.fingerPos.y = lerp(this.state.fingerPos.y, f.fingerPos.y, kPos);

    /* ---------- 旋转：累积角度 + 角速度 ---------- */
    if (this._prevRotation !== null) {
      let d = f.rotation - this._prevRotation;
      // 处理 ±π 跳变，保证可以连续累积
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // 只有当转动足够明显时才累积，避免抖动被积分放大
      if (Math.abs(d) < 0.35) {
        this.state.rotationAccum += d;
      }
      const speed = dt > 1e-4 ? d / dt : 0;
      this.state.rotationSpeed = lerp(this.state.rotationSpeed, speed, kRot);
    }
    this._prevRotation = f.rotation;

    /* ---------- 捏合 ---------- */
    if (this._prevPinch !== null && dt > 1e-4) {
      const dp = Math.abs(f.pinch - this._prevPinch);
      // 捏合变化过快时不做平滑，保证响应跟手
      const k = dp > 0.12 ? 1 : kOther;
      this.state.pinch = lerp(this.state.pinch, f.pinch, k);
    } else {
      this.state.pinch = f.pinch;
    }
    this._prevPinch = f.pinch;

    /* ---------- 深度 / 手指数 ---------- */
    this.state.depth = lerp(this.state.depth, f.depth, kOther);
    this.state.extendedCount = f.extendedCount;
    this.state.indexOnly = f.indexOnly;

    /* ---------- 挥手：掌心水平速度 ---------- */
    if (this._prevPalm && dt > 1e-4) {
      const vx = (f.palm.x - this._prevPalm.x) / dt;
      // 挥手 = 明显且较快的水平移动
      const speed = Math.abs(vx);
      const target = clamp01((speed - 1.2) / 2.4);
      this.state.wave = lerp(this.state.wave, target, kOther);
    }
    this._prevPalm = f.palm;

    this._time += dt;
    return this.state;
  }
}

/* ------------------------------------------------------------------ *
 * 动作判定：把连续信号变成「事件」
 * ------------------------------------------------------------------ */

/**
 * 事件检测器。
 * 有些动作需要「触发一次」而不是持续生效（例如挥手散开、
 * 捏合到极限时来一次爆开），这里负责边沿检测与冷却。
 */
export class ActionDetector {
  constructor() {
    this._prev = {};
    this._cooldown = {};
  }

  /**
   * @param {string} name 事件名
   * @param {boolean} condition 当前是否满足
   * @param {number} dt 秒
   * @param {number} cooldown 冷却秒数
   * @returns {boolean} 本帧是否「刚刚」满足
   */
  edge(name, condition, dt, cooldown = 0.6) {
    // 冷却计时
    this._cooldown[name] = Math.max(0, (this._cooldown[name] || 0) - dt);

    const was = this._prev[name] || false;
    const rising = condition && !was;
    this._prev[name] = condition;

    if (rising && this._cooldown[name] <= 0) {
      this._cooldown[name] = cooldown;
      return true;
    }
    return false;
  }

  /** 连续量超过阈值时触发（用于「挥手」这类需要峰值的动作） */
  peak(name, value, threshold, dt, cooldown = 0.8) {
    return this.edge(name, value > threshold, dt, cooldown);
  }
}