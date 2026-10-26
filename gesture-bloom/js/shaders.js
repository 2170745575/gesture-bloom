/**
 * shaders.js —— 顶点 / 片元着色器
 *
 * 设计要点：
 *   1. 位置插值全部在 GPU 完成：position = mix(budPos, bloomPos, spread)
 *      因此 1~2 万粒子在切换状态时 CPU 零开销。
 *   2. spread 带逐粒子延迟（基于 aPetal 与 aLayer），让花瓣依次绽放，
 *      形成波浪式的开合动画。
 *   3. 每帧只上传少量 uniform（spread / 手掌位置 / 时间）。
 */

export const flowerVertexShader = /* glsl */ `
precision highp float;

/* ---------- 从几何体读取的属性 ---------- */
attribute vec3  aPosBud;    // 花苞位置
attribute vec3  aPosMorph;  // 目标形态位置（由 JS 切换形态时更新）
attribute vec3  aColor;     // 基础颜色
attribute float aRandom;
attribute vec4  aSeed;
attribute float aLayer;     // 0 = 外层, 1 = 最内层
attribute float aSize;
attribute float aPhase;
attribute float aPetal;     // 花瓣角度
attribute float aSpawn;     // 入场动画进度 [0,1]

/* ---------- 逐帧 uniform ---------- */
uniform float uTime;
uniform float uSpread;       // 0 = 花苞, 1 = 绽放
uniform float uSize;         // 基础粒子尺寸
uniform vec2  uHand;         // 手掌位置 [-1,1]
uniform vec2  uHandVel;      // 手掌速度，用于拖尾/拉伸
uniform float uPixelRatio;
uniform float uGlobalFade;   // 全局淡入
uniform float uBreath;       // 呼吸强度
/** 旋转（弧度）：手指转动时整朵花跟着转 */
uniform float uSpin;
/** 单指追踪：食指尖位置（归一化到掌心坐标系） */
uniform vec2  uFinger;
/** 单指追踪强度 [0,1]：只有食指单独伸出时才 > 0 */
uniform float uFingerActive;
/** 捏合缩放：1 = 原始大小 */
uniform float uScale;
/** 吹散强度 [0,1.6]：挥手时把花瓣向外推一把，随后自然回位 */
uniform float uScatter;
/**
 * 形态混合 [0,1]：
 *   0 = 保持花朵形态（在花苞 ↔ 绽放之间插值）
 *   1 = 完全变成 aPosMorph 指定的目标形态
 * 由 JS 缓动驱动，切换形态时平滑过渡。
 */
uniform float uMorph;
/** 形态自身的动画强度（例如蝴蝶扇翅、星系旋转） */
uniform float uShapeTime;

varying vec3  vColor;
varying float vGlow;
varying float vAlpha;
varying float vLayer;
varying float vSpreadLocal;

void main() {
  float t = uTime;

  /* ---------- 1. 逐粒子延迟的开合（螺旋绽放） ---------- */
  // 让花瓣依次打开而不是整体同时张开：
  // 按花瓣角度排序，相邻花瓣之间形成时间差，
  // 视觉上就是花朵「旋着」一圈圈展开。
  float petalPhase = fract(aPetal / 6.2831853);
  // 螺旋绽放的关键：延迟同时受「花瓣角度」和「层」影响，
  // 外圈先开、内圈后开，并且沿圆周顺序推进。
  float delay = petalPhase * 0.42 + aLayer * 0.18;
  // 把 spread 重映射到 [-delay, 1-delay]，再做 smoothstep
  float s = clamp((uSpread - delay * 0.6) / (1.0 - delay * 0.6), 0.0, 1.0);
  float localSpread = s * s * (3.0 - 2.0 * s);
  vSpreadLocal = localSpread;

  /* ---------- 2. 位置插值（核心） ---------- */
  // 三级混合：
  //   ① 花朵内部：花苞位置 ↔ 绽放位置（由 localSpread 驱动）
  //   ② 花朵 ↔ 目标形态（由 uMorph 驱动）
  //   ③ 变形过程中加一点「飞行弧线」，让粒子是"飞过去"而不是"淡过去"
  vec3 flowerPos = mix(aPosBud, position, localSpread);

  // 变形时的路径扰动：uMorph 在中间值（0.5 附近）时位移最大，
  // 粒子像被抛出去一样划过一段弧线，比直线插值生动得多。
  float morphArc = sin(uMorph * 3.14159);
  vec3 arc = (aSeed.xyz - 0.5) * 2.0 * morphArc * 0.55;
  // 额外的抬升，避免所有粒子都在同一平面里穿行
  arc.y += morphArc * 0.45 * (aSeed.w - 0.5) * 2.0;

  vec3 pos = mix(flowerPos, aPosMorph + arc, uMorph);

  /* ---------- 2b. 形态自身的动画 ---------- */
  // 只在变形基本完成后生效，避免与飞行过程互相干扰。
  float shapeAnim = smoothstep(0.55, 1.0, uMorph);
  if (shapeAnim > 0.001) {
    /* 蝴蝶扇翅：按 |x| 决定抬升，翅膀上下摆动 */
    float flap = sin(uShapeTime * 2.4) * 0.30;
    pos.y += abs(pos.x) * flap * shapeAnim;

    /* 尾鳍/尾巴摆动：越靠 -x 摆得越明显 */
    float tailAmt = clamp(-pos.x * 0.55, 0.0, 1.0);
    pos.y += tailAmt * tailAmt * sin(uShapeTime * 1.9) * 0.42 * shapeAnim;

    /* 星系旋转：整体绕视线轴（Z）转（外侧转得慢，模拟较差自转）。
       注意旋转轴要选 Z —— 星系盘现在建在 XY 平面、正对相机，
       绕 Z 转才是"在画面里旋转"；绕 Y 转会让盘面翻出去、又变成一条线。 */
    float galR = length(pos.xy);
    float galAng = uShapeTime * 0.22 * (1.0 / (0.5 + galR * 0.28));
    float gc = cos(galAng);
    float gs = sin(galAng);
    pos.xy = mat2(gc, -gs, gs, gc) * pos.xy;

    /* 心跳：整体轻微缩放（对心形与花苞都有加成） */
    float beat = 1.0 + sin(uShapeTime * 3.2) * 0.030;
    pos *= mix(1.0, beat, shapeAnim);
  }
  /* ---------- 3. 绽放时的抖动与花瓣旋转 ---------- */
  // 抖动必须很小：花朵半径约 2.7，抖动超过 ~0.04 就会把花瓣轮廓糊掉。
  // 实测把 localSpread 系数设到 0.028 时，绽放态已经明显"发虚"——
  // 18000 个粒子各自偏移一点，叠加起来就把花瓣边界抹平了，
  // 看起来像一团尘埃而不是有花瓣的花。这里再收紧一半。
  vec3 jitter = (aSeed.xyz - 0.5) * 2.0;
  pos += jitter * (0.003 + localSpread * 0.013) * (1.0 - uMorph * 0.7);

  /* 花瓣涡旋：
     每片花瓣绕花朵中轴扭转。扭转量 = 绽放程度 × 花瓣自身的展开进度。
     注意：这是**花朵专属**的变形。形态数据是立在 XY 平面上的，
     而这里旋转的是 XZ 平面——如果不按 uMorph 淡出，
     平面图形会被"拧"出平面，变成一条斜向的糊状带
     （实测心形在绽放态下完全不可辨，原因就在这里）。
     幅度同时控制在 0.35 rad 以内，再大花瓣会被绞成漩涡、失去轮廓。 */
  float flowerOnly = 1.0 - uMorph;
  float petalTwist = localSpread * 0.35 * (1.0 - petalPhase * 0.5) * flowerOnly;
  // 加上随时间缓慢变化的整体涡旋，让静止时也有生气
  float swirl = petalTwist
    + localSpread * 0.05 * sin(t * 0.35 + aPhase) * (0.4 + aLayer * 0.6) * flowerOnly;
  float cs = cos(swirl);
  float sn = sin(swirl);
  pos.xz = mat2(cs, -sn, sn, cs) * pos.xz;

  /* ---------- 4. 呼吸感 ---------- */
  // 花苞状态轻微起伏，像在等待绽放（幅度很小，不能破坏轮廓）
  // 同样按 uMorph 淡出：整体缩放会让平面图形的比例失真。
  float breathAmp = uBreath * (0.020 - localSpread * 0.012) * flowerOnly;
  pos *= 1.0 + sin(t * 1.15 + aPhase) * breathAmp;
  pos.y += sin(t * 0.9 + aPhase * 1.7) * breathAmp * 1.6;

  /* ---------- 5. 手指跟随 ---------- */
  // 手掌位置映射到世界坐标的偏移量。
  // 注意：这里只做「整体平移 + 轻微方向性拉伸」，
  // 不做逐粒子的径向排斥——那会让粒子在手指附近堆成一个亮斑。
  float distFromCore = length(position.xz);
  float followStrength = (0.26 + localSpread * 0.42) * flowerOnly;
  // 位移基本是「整体平移」：各粒子偏移量差异要小。
  // 之前用 (0.55 + distFromCore * 0.18) 让外圈偏移更多，
  // 结果花瓣被拉长、形状失真。现在改成几乎均匀的平移。
  vec2 offset2 = uHand * followStrength * (0.88 + distFromCore * 0.045);
  pos.x += offset2.x;
  pos.y += offset2.y * 0.78;

  // 速度带来的轻微拖尾拉伸（幅度很小，避免粒子被扯散）
  pos.xy -= uHandVel * 0.035 * localSpread * (0.4 + aSeed.w);

  /* ---------- 5b. 单指抽出花瓣并跟随手指 ---------- */
  // 食指单独伸出时，花瓣被「吸」向指尖：
  //   · 指尖附近的粒子被明显牵引（高斯衰减，越近越强）
  //   · 花苞状态下牵引更强，像用手指把花瓣一点点抽出来
  if (uFingerActive > 0.001) {
    // 指尖在花朵本地坐标系里的目标位置（缩放到与花瓣同一量级）
    vec2 fingerLocal = uFinger * 2.3;
    vec2 toFinger = fingerLocal - pos.xy;
    float dFinger = length(toFinger);
    // 影响半径 ~1.8 个世界单位
    float influence = exp(-dFinger * dFinger * 0.42);
    // 花苞时牵引更明显，张开后减弱（张开时花瓣已经舒展开）
    // 同样只对花朵态生效：形态有自己的轮廓，被指尖拉会变形。
    float pullStrength = uFingerActive * (0.62 - localSpread * 0.30) * flowerOnly;
    pos.xy += toFinger * influence * pullStrength;

    // 被指尖拉动的粒子额外抬高，形成「挑起来」的观感
    pos.z += influence * uFingerActive * 0.35 * (1.0 - localSpread * 0.5) * flowerOnly;
  }

  /* ---------- 5c. 手指旋转 → 整朵花旋转 ---------- */
  // uSpin 由 JS 累积（可连续转多圈），这里让粒子绕中轴整体旋转。
  // 与前面的「花瓣涡旋」不同：涡旋是每片花瓣自转，这里是整体刚性旋转。
  if (abs(uSpin) > 0.0001) {
    float csS = cos(uSpin);
    float snS = sin(uSpin);
    pos.xz = mat2(csS, -snS, snS, csS) * pos.xz;
  }

  /* ---------- 5d. 捏合缩放 ---------- */
  pos *= uScale;

  /* ---------- 5e. 吹散（挥手触发） ---------- */
  // 沿粒子自身的径向向外推，并带一点随机性，像被一阵风吹开。
  // 强度会衰减，所以花瓣会自己「飘回来」。
  if (uScatter > 0.001) {
    vec2 radial = pos.xy - vec2(0.0, 0.0);
    float rl = length(radial);
    if (rl > 1e-4) {
      radial /= rl;
    } else {
      radial = vec2(cos(aPhase), sin(aPhase));
    }
    // 越靠外的粒子被推得越远（符合「散开」的直觉）
    float pushAmount = uScatter * (0.55 + rl * 0.28) * (0.7 + aRandom * 0.6);
    pos.xy += radial * pushAmount;
    pos.z += pushAmount * 0.35 * (aSeed.w - 0.5) * 2.0;
  }

  /* ---------- 6. 花苞状态整体收拢 ---------- */
  // localSpread 已经通过 mix(aPosBud, position) 完成了主要收拢，
  // 这里只做一点点收边和拉高，别把花苞又撑回去。
  float budSquash = 1.0 - localSpread;
  pos.xz *= 1.0 - budSquash * 0.10;
  pos.y  *= 1.0 + budSquash * 0.10;

  /* ---------- 7. 入场动画 ---------- */
  float appear = smoothstep(aSpawn * 0.85, aSpawn * 0.85 + 0.15, uGlobalFade);
  pos *= 0.55 + appear * 0.45;

  /* ---------- 8. 投影 ---------- */
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  /* ---------- 9. 尺寸 ---------- */
  // 粒子要足够小，让花瓣轮廓由「粒子排列」而不是「粒子光斑」来定义；
  // 点太大时几千个点会互相糊成一片白。
  float sizeScale = uSize * aSize * (0.72 + localSpread * 0.62);
  // 透视衰减
  gl_PointSize = sizeScale * uPixelRatio * (150.0 / -mvPosition.z);
  // 花苞状态粒子稍大，形成实体感
  gl_PointSize *= 1.0 + budSquash * 0.22;
  gl_PointSize *= appear;

  // 兜底夹紧：swiftshader 等软件渲染器上点尺寸可能异常放大
  gl_PointSize = clamp(gl_PointSize, 0.6, 14.0);

  vColor = aColor;
  vLayer = aLayer;

  /* ---------- 10. 光晕强度 ---------- */
  // 花瓣尖端 & 亮色粒子更亮
  float tipGlow = smoothstep(0.0, 1.0, length(aColor)) * 0.5;
  vGlow = (1.00 + tipGlow * 0.42 + localSpread * 0.28) * appear;
  // 周期性闪烁，让粒子有“呼吸的光”
  vGlow *= 0.86 + 0.14 * sin(t * 2.1 + aPhase * 3.3 + aRandom * 6.28);

  vAlpha = (0.42 + localSpread * 0.46 + aRandom * 0.15) * appear;

  // 变形到其他形态时整体降能量。
  // 原因：花朵的粒子是「散开的花瓣」，而形态（心形/蝴蝶等）把同样多的粒子
  // 压缩到一条轮廓线上，局部密度高得多，加法混合下必然过曝成白带。
  // 实测未降低时心形覆盖率 55%、平均亮度 123，形状完全被白光吞掉。
  vAlpha *= mix(1.0, 0.52, uMorph);

  /* ---------- 11. 花心降密 ---------- */
  // 花心是三层花瓣 + 抽花瓣流光 + 花粉的叠加点，是整幅画面最容易过曝的地方。
  //
  // 关键：压制强度必须随绽放程度变化。
  //   · 花苞状态下粒子本来就聚成一团，此时压花心等于把整个花苞压暗（实测掉到 6/255）
  //   · 绽放状态下三层花瓣在原点堆叠，才需要压
  // 另外，变形到其他形态时（蝴蝶/心形等）粒子也会在中轴聚集，
  // 所以把 uMorph 的影响一并计入，否则蝴蝶会糊成一个白团。
  float rFromCore = length(pos.xy) / 3.6;
  float coreMask = smoothstep(0.0, 1.0, rFromCore);
  // 取「绽放程度」与「变形程度」的较大者，两者任一成立都要压制。
  // 绽放态的压制范围要更大（花瓣尖端也参与叠加），所以用 coreMask 的一次方
  // 乘以更低的系数，而不是之前的平方——平方只压最中心，边缘照样过曝。
  float stackAmt = max(localSpread, uMorph);
  float suppress = mix(1.0, coreMask * 0.62 + 0.30, stackAmt);
  vAlpha *= suppress;
}
`;

export const flowerFragmentShader = /* glsl */ `
precision highp float;

varying vec3  vColor;
varying float vGlow;
varying float vAlpha;
varying float vLayer;
varying float vSpreadLocal;

uniform float uTime;
/** 形态混合进度。片段着色器里也要用（压低颜色强度避免轮廓过曝），
    所以必须在**两个着色器里都声明**——只在顶点里声明会导致
    "Fragment shader is not compiled: 'uMorph' : undeclared identifier"，
    整个花朵会退化成无法辨识的模糊光云。 */
uniform float uMorph;

void main() {
  /* 圆形柔边粒子：用 gl_PointCoord 算径向距离 */
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;

  float r = sqrt(r2) * 2.0;   // 0 = 中心, 1 = 边缘

  /* 核心 + 光晕两层叠加。
     加法混合下 alpha 就是「能量权重」。
     实测：18000 个粒子在绽放态叠加时，系数 0.62/0.40 会让花瓣尖端
     烧成硬白块（单独看主体层就能看到明显过曝），
     而花瓣的层次感完全丢失。这里整体压低，靠"粒子多"而不是"粒子亮"出亮度。 */
  float core = smoothstep(1.0, 0.18, r);          // 实心核心
  float halo = pow(1.0 - r, 2.4);                 // 柔和外晕
  // 权衡：0.62/0.40 → 花瓣尖端烧成硬白块；0.44/0.30 → 整朵偏暗。
  // 取中间值，再配合下面的「绽放态核心压制」一起控制过曝。
  float alpha = (core * 0.56 + halo * 0.36) * vAlpha;

  /* 颜色：中心提亮，形成明亮的花心 */
  vec3 col = mix(vColor, vec3(1.0), core * 0.24);
  col += vec3(0.13, 0.10, 0.19) * halo;

  /* 发光强度 */
  col *= min(vGlow, 1.35);
  // 变形时同步压低颜色强度，避免轮廓线叠成纯白
  col *= mix(1.0, 0.72, uMorph);

  /* 内层花蕊偏暖，外层偏冷，增强层次 */
  col = mix(col, col * vec3(1.08, 1.0, 0.90), vLayer * 0.6);

  /* 微弱色差，让绽放时更有“光感” */
  float hueShift = vSpreadLocal * 0.06;
  col.r += hueShift * (1.0 - r);
  col.b -= hueShift * 0.5 * (1.0 - r);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/* ------------------------------------------------------------------ *
 * 背景星尘：疏朗的大颗粒，提供景深感
 * ------------------------------------------------------------------ */

export const dustVertexShader = /* glsl */ `
precision highp float;
attribute float aSize;
attribute float aPhase;
attribute float aRandom;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
uniform vec2 uHand;
uniform float uSpread;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 pos = position;
  // 漂浮速度要很慢。
  // 星尘数量提到 3200 之后，原来 0.18 的漂移速度会让整幅画面每帧变化 10%+
  // （实测把星尘隐藏后只剩 1.6%），花苞态看起来"整片星空在抖"。
  // 降到 0.04 之后星空仍是活的，但不抢主体。
  pos.x += sin(uTime * 0.04 + aPhase) * 0.55;
  pos.y += cos(uTime * 0.032 + aPhase * 1.3) * 0.45;
  pos.z += sin(uTime * 0.026 + aPhase * 0.7) * 0.35;

  // 被手掌轻微推开。
  // 注意两点：
  //   1. 系数必须真的在 uSpread=0 时归零。原来写成 (0.4 + uSpread)，
  //      花苞态仍有 0.4 的推力，配合 normalize() 在近零向量上的不稳定，
  //      会让整片星空持续抖动（实测花苞态画面变化 10.2%，关掉星尘后仅 1.6%）。
  //   2. 用「软化的」方向向量代替 normalize()，避免除零抖动。
  vec2 away = pos.xy - uHand * 4.0;
  float d2 = dot(away, away);
  float falloff = exp(-d2 * 0.35);
  vec2 dir = away / sqrt(d2 + 0.5);      // 天然有界，不需要 normalize
  pos.xy += dir * falloff * 0.8 * uSpread;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uPixelRatio * (200.0 / -mv.z);
  gl_PointSize = clamp(gl_PointSize, 0.5, 7.0);

  vColor = aColor;
  // 背景星尘要能看见，否则整幅画面像纯黑。
  // 实测「花朵像素已达 223/255 但观感仍偏暗」，根因是背景占了 85% 的画面且接近纯黑。
  // 提高星尘亮度/密度是解决「闷」最直接的手段。
  //
  // 闪烁处理：3200 颗星若每颗都以同幅度闪烁，整体画面变化会达到 13%
  // （实测关闭星尘后仅 1.6%），花苞态看起来"很吵"、抢主体注意力。
  // 这里只让约 1/4 的星（aRandom < 0.25 的那批）参与闪烁，其余保持稳定亮度，
  // 既保留"星空在呼吸"的感觉，又不会整片闪。
  float twinkleMask = step(aRandom, 0.25);
  vAlpha = 0.52
    + twinkleMask * 0.30 * (0.5 + 0.5 * sin(uTime * 0.55 + aPhase * 2.0));
  // 被手指/手掌搅动的星尘更亮，增强互动感
  vAlpha *= 1.0 + exp(-distance(pos.xy, uHand * 4.0) * 0.5) * 0.5 * uSpread;
}
`;

export const dustFragmentShader = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  // 外晕更柔，让星尘看起来像发光的小点而不是硬边圆片
  float core = smoothstep(1.0, 0.25, r);
  float halo = pow(1.0 - r, 2.0);
  float a = (core * 0.65 + halo * 0.5) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

/* ------------------------------------------------------------------ *
 * 星云背景：覆盖全屏的柔和色雾
 *
 * 作用：单靠星点无法消除「大片纯黑」的观感。
 * 星云是一层极低亮度、缓慢流动的彩色雾，把背景从"死黑"变成"有层次的暗"，
 * 这会显著提升整幅画面的通透感——而且因为亮度极低，
 * 几乎不会与前景的花朵争夺注意力，也不会推高过曝比例。
 * ------------------------------------------------------------------ */

export const nebulaVertexShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const nebulaFragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform vec2  uHand;
uniform float uSpread;
uniform float uAspect;

/* 便宜的伪随机与值噪声（够用即可，不需要高质量） */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  // 以中心为原点，修正宽高比让雾团不被拉伸
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float dist = length(p);

  // 缓慢流动的两层噪声
  vec2 q = p * 2.1 + vec2(uTime * 0.018, uTime * 0.012);
  float n1 = fbm(q);
  float n2 = fbm(p * 3.4 - vec2(uTime * 0.013, uTime * 0.021));
  float density = n1 * 0.65 + n2 * 0.35;

  // 中央更亮：花朵周围形成一圈柔光，让主体"坐"在光里而不是浮在虚空中
  float centerGlow = exp(-dist * dist * 1.9);

  // 手掌附近也亮一点，制造"手带动光"的感觉
  vec2 handP = uHand * vec2(uAspect, 1.0) * 0.5;
  float handGlow = exp(-dot(p - handP, p - handP) * 3.2) * 0.45 * uSpread;

  float energy = density * 0.55 + centerGlow * 0.75 + handGlow;

  // 配色：中心偏暖粉，外围偏蓝紫，与花朵配色呼应
  vec3 warm = vec3(0.55, 0.30, 0.48);
  vec3 cool = vec3(0.16, 0.24, 0.52);
  vec3 col = mix(cool, warm, clamp(centerGlow + density * 0.25, 0.0, 1.0));

  // 整体亮度压得很低：这是背景雾，不是灯
  float alpha = energy * 0.30;
  // 边缘淡出，避免出现方形边界
  alpha *= smoothstep(1.25, 0.15, dist);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;