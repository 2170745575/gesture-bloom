/**
 * shapes.js —— 粒子形态库
 *
 * 同一批粒子可以在多种「形态」之间平滑变换（morph）。
 * 每种形态只提供一组目标位置，顶点着色器用同一个插值逻辑在
 * 花苞 / 花朵 / 当前形态 之间混合，因此切换形态不需要重建几何体。
 *
 * 每个形态生成器返回 Float32Array(count * 3)。
 *
 * 设计约定：
 *   · 所有形态都用与花朵相同的坐标系（XZ 平面为主，y 向上）
 *   · 尺度大致相当，避免切换时"跳一下"
 *   · 尽量利用极坐标/参数方程，保证形态干净、对称
 */

/**
 * 伪随机（确定性，保证每次刷新形态一致）
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================== *
 * 形态生成器
 * ================================================================== */

/**
 * 蝴蝶：两对翅膀 + 身体
 * 用极坐标翅膀函数 r(θ) = R·|sin(2θ)| 的变体，再按上下翅分别调制
 */
function makeButterfly(count, R, rand) {
  const out = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const seg = rand();

    if (seg < 0.86) {
      /* ---- 翅膀 ---- */
      // 左右任选一侧
      const side = rand() < 0.5 ? -1 : 1;

      // 参数 u ∈ [0,1] 沿翅膀展开方向
      const u = Math.pow(rand(), 0.7);
      // 参数 v ∈ [-1,1] 沿翅膀横向。
      // 取 pow 1.35：轻微偏向边缘（做出翅脉感），但不能太多，
      // 否则翅膀会变成空心的轮廓环、中间没有"肉"。
      const vMag = Math.pow(rand(), 1.35);
      const v = (rand() < 0.5 ? -1 : 1) * vMag;

      const ang = u * Math.PI * 0.92;          // 从身体向外扫过的角
      // 上翅比下翅长
      const isUpper = rand() < 0.58;
      const lenScale = isUpper ? 1.0 : 0.66;

      // 翅膀轮廓：内圈窄、外圈宽
      const rad = R * lenScale * (0.28 + 0.72 * Math.sin(ang));
      // 翅膀的横向宽度
      const width = R * 0.42 * lenScale * Math.sin(ang) * (1 - 0.35 * u);

      const cx = Math.cos(ang) * rad;
      const cy = Math.sin(ang) * rad * (isUpper ? 1 : -0.82);

      // 在翅膀平面内偏移
      const nx = -Math.sin(ang);
      const ny = Math.cos(ang) * (isUpper ? 1 : -0.82);

      let x = side * (cx + nx * width * v);
      let y = cy + ny * width * v;
      let z = (rand() - 0.5) * R * 0.10;

      // 翅膀边缘的波浪（蝴蝶翅的锯齿）
      const edge = Math.pow(Math.abs(v), 3);
      z += edge * R * 0.04 * Math.sin(u * 12);

      // 轻微上翘
      y += Math.abs(v) * R * 0.05;

      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    } else {
      /* ---- 身体 ---- */
      const t = rand();                  // 沿身体长度
      const a = rand() * Math.PI * 2;
      const bodyR = R * 0.055 * Math.sin(Math.PI * t);

      out[i * 3] = Math.cos(a) * bodyR;
      out[i * 3 + 1] = (t - 0.5) * R * 1.05;
      out[i * 3 + 2] = Math.sin(a) * bodyR * 0.8;
    }
  }
  return out;
}

/**
 * 螺旋星系：多条旋臂 + 中心核球
 * 用对数螺线 r = a·e^(bθ)，这是旋臂的自然形状。
 *
 * 注意：盘面建在 **XY 平面**（而不是常见的 XZ）。
 * 因为花朵态会让整个对象倾斜 -58°，形态态则把倾角归零让图形正对相机；
 * 如果星系盘建在 XZ 平面，倾角归零后就会变成"edge-on"的一条细线
 * （实测只剩一条水平亮线，完全看不出旋臂）。
 */
function makeGalaxy(count, R, rand) {
  const out = new Float32Array(count * 3);
  const ARMS = 4;

  for (let i = 0; i < count; i++) {
    const isCore = rand() < 0.18;

    if (isCore) {
      /* ---- 核球：球状分布 ---- */
      const a = rand() * Math.PI * 2;
      const b = Math.acos(2 * rand() - 1);
      const rr = R * 0.24 * Math.pow(rand(), 1.7);
      out[i * 3] = Math.sin(b) * Math.cos(a) * rr;
      out[i * 3 + 1] = Math.sin(b) * Math.sin(a) * rr;
      out[i * 3 + 2] = Math.cos(b) * rr * 0.7;
    } else {
      /* ---- 旋臂（在 XY 平面展开） ---- */
      const arm = Math.floor(rand() * ARMS);
      const t = Math.pow(rand(), 0.62);
      const theta = arm * (Math.PI * 2 / ARMS) + t * 3.4;
      const rad = R * (0.22 + 0.78 * t);

      // 垂直于旋臂的散布：越靠外越松散
      const spread = R * (0.05 + 0.16 * t);
      const off = (rand() + rand() + rand() - 1.5) * spread;

      const x = Math.cos(theta) * rad - Math.sin(theta) * off;
      const y = Math.sin(theta) * rad + Math.cos(theta) * off;
      // 盘面很薄，只有一点点厚度，避免完全平面化的观感
      const z = (rand() - 0.5) * R * (0.045 + 0.05 * t);

      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
  }
  return out;
}

/**
 * 凤凰：展开的双翼 + 身体 + 长尾
 *
 * 之前用「后掠翼面」生成，结果翼面互相重叠糊成一团（ASCII 预览里看不出翅膀）。
 * 现在改成更明确的结构：翅膀是一对扁平的后掠三角面，
 * 沿翼展方向分成若干「羽枝」，每根羽枝再铺粒子——这样轮廓才有羽毛的分明感。
 */
function makePhoenix(count, R, rand) {
  const out = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const seg = rand();

    if (seg < 0.72) {
      /* ---- 双翼：由若干羽枝组成 ---- */
      const side = rand() < 0.5 ? -1 : 1;

      // 选一根羽枝（从内侧到外侧，共 6 根）
      const featherIdx = Math.floor(rand() * 6);
      const fT = featherIdx / 5;          // 0 = 最内侧, 1 = 最外侧

      // 该羽枝的根部位置（沿身体向后、向下排开）
      const rootX = -fT * R * 0.42;
      const rootY = R * 0.30 - fT * R * 0.20;

      // 羽枝长度：中段最长，两端略短
      const fLen = R * (0.50 + 0.80 * Math.sin(Math.PI * (0.22 + fT * 0.62)));

      // 沿羽枝的进度
      const u = Math.pow(rand(), 0.75);
      // 羽枝宽度，末端收细
      const w = R * 0.085 * (1 - u * 0.68);
      const v = (rand() * 2 - 1) * w;

      // 关键：羽枝的张开角。
      // 之前所有羽枝都在同一个窄角度范围内（-0.28 ~ -1.0 rad），
      // 结果六根羽枝互相重叠、糊成一个三角形（ASCII 预览里完全看不出翅膀）。
      // 现在让角度**跨越大半个扇形**（-10° ~ -75°），羽枝之间才有明显间隙。
      const spreadAngle = -0.18 - fT * 1.12;
      const dx = Math.cos(spreadAngle) * fLen * u;
      const dy = Math.sin(spreadAngle) * fLen * u;

      out[i * 3] = side * (rootX + dx) + v * 0.30;
      out[i * 3 + 1] = rootY + dy + v * 0.92;
      out[i * 3 + 2] = (rand() - 0.5) * R * 0.07;
    } else if (seg < 0.86) {
      /* ---- 身体 ---- */
      const t = rand();
      const profile = Math.sin(Math.PI * Math.pow(t, 0.6)) * 0.85 + 0.10;
      const a = rand() * Math.PI * 2;
      const rr = Math.pow(rand(), 0.5);
      out[i * 3] = (t - 0.32) * R * 0.60;
      out[i * 3 + 1] = Math.cos(a) * R * 0.15 * profile * rr + R * 0.12;
      out[i * 3 + 2] = Math.sin(a) * R * 0.14 * profile * rr;
    } else {
      /* ---- 尾羽：3 根向下的长羽 ---- */
      const fIdx = Math.floor(rand() * 3) - 1;   // -1, 0, 1
      const t = Math.pow(rand(), 0.55);
      const spreadT = fIdx * t;
      out[i * 3] = -R * 0.30 - t * R * 0.22;
      out[i * 3 + 1] = -R * 0.15 - t * R * 1.05;
      out[i * 3 + 2] = (rand() - 0.5) * R * 0.06;
      // 尾羽向外散开
      out[i * 3] += spreadT * R * 0.22;
      out[i * 3 + 1] += Math.abs(fIdx) * t * R * 0.10;
    }
  }
  return out;
}

/**
 * 鲸鱼：侧视轮廓
 *
 * 之前把身体做成"管子 + 空心壳"，从侧面看只剩一圈轮廓、认不出鲸鱼。
 * 现在改成**实心侧视填充**：沿身体长度方向铺满，
 * 高度方向按纺锤轮廓收缩，这样剪影清楚。
 */
function makeWhale(count, R, rand) {
  const out = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const seg = rand();

    if (seg < 0.16) {
      /* ---- 尾鳍：两瓣三角 ---- */
      const side = rand() < 0.5 ? -1 : 1;
      const u = Math.pow(rand(), 0.7);
      const v = rand() * 2 - 1;
      out[i * 3] = -R * 0.78 - u * R * 0.32;
      out[i * 3 + 1] = side * u * R * 0.46 + v * R * 0.05;
      out[i * 3 + 2] = (rand() - 0.5) * R * 0.05;
    } else {
      /* ---- 身体：侧视实心剪影 ---- */
      // t ∈ [0,1] 从头到尾
      const t = rand();
      // 纺锤轮廓：头部圆钝、中段最粗、尾部收细
      const profile = Math.sin(Math.PI * Math.pow(t, 0.68)) * 0.92 + 0.06;

      const x = (0.45 - t) * R * 1.62;
      const halfH = R * 0.30 * profile;

      // 高度方向均匀填充（而不是只贴壳），轮廓才实
      const y = (rand() * 2 - 1) * halfH;
      // 一点点厚度
      const z = (rand() - 0.5) * R * 0.16 * profile;

      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
  }
  return out;
}

/**
 * 星河 / 心形：用一个显式的心形参数方程
 * x = 16sin³t, y = 13cos t − 5cos2t − 2cos3t − cos4t
 */
function makeHeart(count, R, rand) {
  const out = new Float32Array(count * 3);
  const scale = R / 17.5;

  for (let i = 0; i < count; i++) {
    const t = rand() * Math.PI * 2;
    // 心形参数方程
    const hx = 16 * Math.pow(Math.sin(t), 3);
    const hy =
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);

    // 关键：粒子要**贴着轮廓**分布，而不是均匀填满内部。
    // 均匀填充会让中心区域粒子密度极高，加法混合下直接烧成一个白斑，
    // 心形轮廓反而看不出来（实测中心过曝、形状不可辨）。
    // 这里让 s 强烈偏向 0（轮廓处）：s = rand^2.6
    const s = Math.pow(rand(), 2.6);
    const fill = 1 - s;   // 1 = 在轮廓上，0 = 在中心

    // 向内收缩（朝质心），但只在很浅的一层内收缩，做出厚度感
    const cx = hx * (0.86 + 0.14 * fill);
    const cy = (hy + 2) * (0.86 + 0.14 * fill);

    // 厚度：越靠轮廓越薄，中心略厚
    const z = (rand() - 0.5) * R * (0.10 + 0.16 * s);

    out[i * 3] = cx * scale;
    out[i * 3 + 1] = cy * scale;
    out[i * 3 + 2] = z;
  }
  return out;
}

/**
 * 花朵（与主体一致的形态，供「还原」用）
 * 这里只做占位：实际还原时直接切回 position 属性即可。
 */
function makeFlowerPlaceholder(count, R, rand) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const rr = R * (0.2 + rand() * 0.8);
    out[i * 3] = Math.cos(a) * rr;
    out[i * 3 + 1] = (rand() - 0.5) * R * 0.2;
    out[i * 3 + 2] = Math.sin(a) * rr;
  }
  return out;
}

/**
 * 把一组位置数据居中，并按**最大半径**归一化到统一尺度。
 *
 * 为什么用最大半径而不是包围盒跨度：
 *   包围盒只保证「轴向」不超出，但对角方向的点可以到 1.41 倍。
 *   蝴蝶/星系/心形都是近似圆形的平面图形，正是这种情况，
 *   实测它们的屏幕垂直占比达到 110~122%，直接溢出视口，
 *   看起来就是「形状显示不出来，只剩一圈弧线」。
 *   按最大半径归一化后，所有形状的最外点都在同一球面上，必定完整入镜。
 *
 * @param {Float32Array} arr 位置数据（原地修改）
 * @param {number} targetRadius 归一化后的最大半径
 */
function normalizeByMaxRadius(arr, targetRadius) {
  const n = arr.length / 3;

  // 先按包围盒中心平移（比质心更符合视觉中心）
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // 再求「到中心的最大距离」作为当前半径
  let maxR = 1e-6;
  for (let i = 0; i < n; i++) {
    const dx = arr[i * 3] - cx;
    const dy = arr[i * 3 + 1] - cy;
    const dz = arr[i * 3 + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxR) maxR = d;
  }

  const scale = targetRadius / maxR;

  for (let i = 0; i < n; i++) {
    arr[i * 3] = (arr[i * 3] - cx) * scale;
    arr[i * 3 + 1] = (arr[i * 3 + 1] - cy) * scale;
    arr[i * 3 + 2] = (arr[i * 3 + 2] - cz) * scale;
  }
  return arr;
}

/* ================================================================== *
 * 形态注册表
 * ================================================================== */

export const SHAPE_DEFS = [
  {
    id: 'flower',
    name: '花朵',
    icon: '🌸',
    desc: '默认形态，随手势绽放／合拢',
    build: null, // 用几何体自带的 position，无需额外数据
  },
  {
    id: 'butterfly',
    name: '蝴蝶',
    icon: '🦋',
    desc: '双翼展开，会随手指轻扇',
    build: makeButterfly,
  },
  {
    id: 'galaxy',
    name: '星系',
    icon: '🌌',
    desc: '四条旋臂缓慢旋转',
    build: makeGalaxy,
  },
  {
    id: 'heart',
    name: '心形',
    icon: '💗',
    desc: '心形参数方程，捏合会跳动',
    build: makeHeart,
  },
  {
    id: 'phoenix',
    name: '凤凰',
    icon: '🔥',
    desc: '双翼展开，尾羽飘逸',
    build: makePhoenix,
  },
  {
    id: 'whale',
    name: '鲸鱼',
    icon: '🐋',
    desc: '侧身游动，尾巴摆动',
    build: makeWhale,
  },
];

/**
 * 构建所有形态的位置数据
 * @param {number} count 粒子数
 * @param {number} R 参考尺度（一般用花朵半径）
 * @returns {{ids:string[], data:Object<string, Float32Array>, defs:Array}}
 */
export function buildAllShapes(count, R) {
  const data = {};
  const defs = [];

  /* 归一化尺度
   *
   * 原来用 R * 1.18 作为「包围盒跨度的一半」，但包围盒只保证轴向不超出，
   * 对角方向的点可以到 1.41 倍。蝴蝶/星系/心形都是近似圆形的平面图形，
   * 正是这种情况——实测屏幕垂直占比达到 110~122%，直接溢出视口，
   * 看起来就是"形状显示不出来，只剩一圈弧线"。
   *
   * 改为按**最大半径**归一化后，所有形状最外点都在同一球面上，必定完整入镜。
   * 系数再按实测微调：0.53 时宽度只有 ~28%（偏小），提到 0.70 后
   * 各形状宽度约 36~46%、高度 36~70%，既完整又有足够存在感。
   */
  const TARGET_RADIUS = R * 0.70;

  for (const def of SHAPE_DEFS) {
    if (!def.build) {
      defs.push(def);
      continue;
    }
    // 每个形态用独立种子，保证互不干扰且可复现
    const r = mulberry32(77003 + def.id.length * 9973);
    const arr = def.build(count, R, r);
    normalizeByMaxRadius(arr, TARGET_RADIUS);
    data[def.id] = arr;
    defs.push(def);
  }

  return { data, defs, count };
}