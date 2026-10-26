# 上传到 GitHub

这个项目是**纯静态**的：不需要构建、不需要服务器，推到 GitHub 再开一下 Pages，
任何人用浏览器就能打开 —— 而且是 **HTTPS**，正好满足摄像头 API 的安全上下文要求。

> 准备工作我已经做完了：本地仓库已初始化、51 个文件已提交、`.gitignore` / `.nojekyll` / `LICENSE` 都已就位。
> 唯一需要你本人的是 **GitHub 授权** —— 这一步没法代替。

---

## 方式一：双击运行（推荐）

**第 1 步**：在 GitHub 上新建一个**空**仓库 → <https://github.com/new>

- 仓库名填 **`gesture-bloom`**
- **不要**勾 Add README / .gitignore / license（勾了会导致首次推送冲突）

**第 2 步**：双击项目根目录的 **`发布.cmd`**

脚本会自动：设置提交身份 → 提交改动 → 配置 origin → 推送（最多重试 10 次，每次换一种连接策略）。
首次推送会**弹出浏览器让你登录 GitHub**，登录一次之后就不用再登了。

**第 3 步**：开启 GitHub Pages → <https://github.com/2170745575/gesture-bloom/settings/pages>

- Source 选 **Deploy from a branch**
- Branch 选 **main** / **/(root)** → Save

约 1 分钟后，任何人都能通过这个地址打开：

```
https://2170745575.github.io/gesture-bloom/
```

> 首次打开会从同站点加载 MediaPipe 模型（约 18 MB），比本地慢一些，
> 之后就走进浏览器缓存了。

---

## 方式二：手动几条命令

如果你更习惯自己敲命令：

```powershell
# 本机没有系统级 git，用便携版
$git = "$env:LOCALAPPDATA\MinGit\cmd\git.exe"
cd "D:\deepseek工作\gesture-bloom"

& $git remote -v                    # 确认 origin 已指向你的仓库
& $git push -u origin main          # 首次会弹浏览器登录
```

然后同样去 Settings → Pages 选 main / (root)。

如果 `git push` 报连接超时（这台机器到 github.com 会间歇性超时），
多试几次，或者用方式一的脚本（它内置了 5 种连接策略轮换）。

---

## 仓库里有什么、没有什么

| 内容 | 入库 | 说明 |
|---|---|---|
| `index.html`、`js/`（9 个模块） | ✅ | 作品本体，约 165 KB |
| `vendor/three/` | ✅ | Three.js r160.1，1.3 MB |
| `vendor/mediapipe/` | ✅ | MediaPipe Hands 全套含模型，**18.2 MB** |
| `_test/*.mjs`（15 个） | ✅ | 自动化验证脚本，136 KB |
| `README.md`、`PUBLISH.md`、`LICENSE` | ✅ | 文档 |
| `启动.cmd`、`发布.cmd`、`server.js`、`_serve.ps1` | ✅ | 本地运行与发布脚本 |
| `.nojekyll` | ✅ | 关闭 Pages 的 Jekyll 处理（否则 `_test/` 这种下划线目录会被忽略） |
| `_test/*.png`（29 张截图，8.1 MB） | ❌ | 验证产物，已在 `.gitignore` 排除，可随时重新生成 |

**入库总计 51 个文件 / 18.97 MB**，最大单文件 6 MB（WASM），远低于 GitHub 100 MB 上限。

### 为什么要传 18 MB 的 MediaPipe

因为**不传就基本没法用**：MediaPipe 需要下载约 18 MB，
其中 6 MB 的 WASM 单文件在慢网络下实测可卡 **40 秒以上**
（日志停在 `still waiting on run dependencies: wasm-instantiate`），
用户点了「开启摄像头」后会长时间毫无反应。

本地化之后，模型与页面同源加载，快得多也稳得多。
`js/config.js` 里保留了 CDN 作为回退源，本地文件缺失时会自动改用 unpkg / jsdelivr。

---

## 部署后的路径兼容性（已核对）

GitHub Pages 会把站点挂在 `https://用户名.github.io/gesture-bloom/` 这种**子目录**下，
绝对路径（`/js/main.js`）会 404。已核对：

- **0 处绝对路径**，全部是相对路径（`./js/...`、`./vendor/...`）
- importmap 用的是 `./vendor/three/build/three.module.js`，子目录下正常
- MediaPipe 的资源基址用 `new URL(url, location.href)` 解析，会自动带上子目录前缀
- **0 处 `file://` 引用**（只有 `server.js` 注释里提到）

### WASM 的 MIME 类型

GitHub Pages 对 `.wasm` 的 MIME 类型不一定是 `application/wasm`，
而 `WebAssembly.instantiateStreaming` 要求正确的 MIME。

**已确认这不会出问题**：MediaPipe 用的是标准 Emscripten 加载器，
内置了回退链：

```
instantiateStreaming 失败
  → "wasm streaming compile failed"
  → "falling back to ArrayBuffer instantiation"
  → instantiateArrayBuffer（对 MIME 无要求）
```

所以即使 MIME 不对，也只是控制台多一条 warning，功能正常。

---

## 可选事项

- **仓库描述**建议写：
  `Gesture-controlled particle flower — MediaPipe Hands + Three.js GPU particles. 6 morphable shapes, fully offline.`
- **Topics** 建议加：`threejs` `mediapipe` `hand-tracking` `webgl` `glsl` `particles` `generative-art`
- **自定义域名**：在 Pages 设置里填，或直接在仓库根目录放一个 `CNAME` 文件
- **私有仓库也能用 Pages**：在 Pages 设置里把可见性改成 Public 即可（免费账号的 Pages 站点是公开的）
- `LICENSE` 目前是 MIT，版权署名写的是 `2170745575`，你可以改成真名

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 推送报 `Repository not found` | 仓库还没建，或名字不对 | 先去 <https://github.com/new> 建空仓库 `gesture-bloom` |
| 推送报连接超时 | 这台机器到 github.com 间歇性超时 | 重跑 `发布.cmd`（内置 5 种策略轮换） |
| 推送报 `rejected / fetch first` | 建仓库时勾了 README | 脚本会自动 `pull --rebase` 后再推 |
| Pages 打开是 404 | Pages 还没生效 | 等 1~2 分钟；确认 Branch 选的是 `main` 和 `/(root)` |
| Pages 上摄像头打不开 | 浏览器权限 | 点地址栏左侧权限图标允许；HTTPS 已满足，不是环境问题 |
| 页面能开但花不动 | 模型还在加载 | 等状态栏走完「正在初始化识别引擎…」 |

本地想先验证一遍的话，双击 `启动.cmd` 即可（`http://localhost:5173`）。