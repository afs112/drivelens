# DriveLens · Google Drive 共享云端相册与多人选片工作台

<p>
  <a href="README.md"><strong>English</strong></a> · <strong>简体中文</strong> · <a href="https://afs112.github.io/drivelens/#lang=zh"><strong>直接打开在线版（免部署即用）↗</strong></a>
</p>

> **无需安装、无需搭建后端、打开浏览器即可使用的 Google Drive 共享相册与多人协同选片工具。**  
> 100% 纯前端运行在您的浏览器中——可直接打开官方在线托管版即开即用，也可 1 分钟一键部署到您自己的域名或本地电脑。

---

## 1. DriveLens 能为您做什么（30 秒速览）

- **丝滑 60fps 暗房级大图画廊（支持 10,000–100,000+ 张照片与视频）**：将任意 Google Drive 文件夹变为瀑布流（Waterfall）、等高排版（Justified）或网格（Grid）画廊，支持智能预加载、增量极速刷新与本地缓存秒开。
- **多人协同选片、互不覆盖**：把同一个相册发给朋友，每个人都可以独立打星（`1–5★`）、收藏（`♥`）、贴彩色标签（`T`）和写批注；支持按 **平均分 / 我的评分 / 指定成员** 筛选，支持 **`2–4` 张同屏对比（`C`）** 与同步缩放，并一键导出精选名单用于 Lightroom / Capture One。
- **桌面与手机原生手感**：支持安装为桌面 / iOS / Android 独立 App（PWA）；在桌面端可直接把**任意照片拖拽到电脑桌面**下载原图；支持右键快捷菜单；看大图时原地轻点或上滑/下滑即可流畅退出。
- **内置离线演示相册**：无需连接任何账号即可直接体验！打开网页即可在 **2026 川西大环线共享相册** 中切换 **我（Alex）**、**Lin**、**Jay** 三位成员视角体验协作选片。

---

## 2. 最快上手方式：零部署直接用（推荐）

无需 Fork 仓库，无需安装 Node.js 或 Python，直接访问在线版即可开始使用：

👉 **[https://afs112.github.io/drivelens/#lang=zh](https://afs112.github.io/drivelens/#lang=zh)**

> **为什么免部署依然 100% 隐私安全？**  
> DriveLens 是纯静态前端应用（**0 后端服务器、0 统计埋点、0 数据上传**）。您的 API Key、Google 登录凭据与所有照片均**只在您的浏览器与 Google 官方服务器之间直接通信**——`afs112.github.io` 不会也无法读取、经过或保存您的任何数据。

请根据您的相册权限选择以下任一连接方式：

### 方式 A：公开链接共享相册（API Key 直连 · 看图最简单，约 2 分钟）

适合“知道链接的人即可看图”的旅行/活动相册，访客无需登录 Google 账号即可看图。

1. **开启文件夹链接共享**：在 Google Drive 右键相册文件夹 → **共享（Share）** → 将“常规访问权限”设为 **知道链接的任何人（查看者 / Viewer）**。
2. **创建免费 API Key**：打开 [Google Cloud Console](https://console.cloud.google.com/) → 创建或选择项目 → 在 **API 和服务 → 库** 中启用 **Google Drive API** → 在 **凭据 → 创建凭据 → API 密钥** 中生成并复制 `AIzaSy...`。（*建议在密钥限制中勾选仅限 Google Drive API。*）
3. **连接并分享**：打开 **[https://afs112.github.io/drivelens/#lang=zh](https://afs112.github.io/drivelens/#lang=zh)** → 点击右上角 **连接 Drive** → 粘贴文件夹链接/ID、API Key 和您的昵称即可！
   - 您还可以直接把下面这种**一键直达链接**发给朋友：
     ```text
     https://afs112.github.io/drivelens/#folder=<FOLDER_ID>&key=<YOUR_API_KEY>&lang=zh
     ```
   - *（提示：纯静态站点下，API Key 模式的评分仅保存在各自浏览器本地；如需私密文件夹或多人云端同步评分，请使用下方的 **方式 B**。）*

### 方式 B：私密文件夹与多人云端同步评分（在自己的 Google OAuth 中授权 `https://afs112.github.io`，无需 Fork！）

适合需要**仅限指定好友看图**的私密相册，或希望大家的评分、标签和批注自动同步保存在 Google Drive 文件夹内部（`.drivelens/`）的场景。

1. **启用 Google Drive API**：在您自己的 [Google Cloud Console](https://console.cloud.google.com/) 中创建项目，并在 **API 和服务 → 库** 中启用 **Google Drive API**。
2. **配置 OAuth 同意屏幕与测试用户**：
   - 打开 **Google Auth Platform → 受众（Audience）**（或 **API 和服务 → OAuth 同意屏幕**）。
   - 选择 **外部（External）**，发布状态保持免费的 **测试中（Testing）** 即可（无需提交 Google 审核）。
   - 在 **测试用户（Test Users）** 中添加您和好友的 Gmail 邮箱（免费支持最多 **100 位协作者**）。
3. **在凭据中直接授权 `https://afs112.github.io`**：
   - 前往 **凭据（Credentials）→ + 创建凭据 → OAuth 客户端 ID → Web 应用（Web application）**。
   - 在 **已获授权的 JavaScript 来源（Authorized JavaScript origins）** 中直接填入：
     ```text
     https://afs112.github.io
     ```
     *（注意：只填域名来源 Origin，**不要**带 `/drivelens` 路径，也不要带末尾 `/`！）*
4. **连接并分享一键链接**：
   - 复制生成的 **客户端 ID**（`xxx.apps.googleusercontent.com`）。
   - 打开 **[https://afs112.github.io/drivelens/#lang=zh](https://afs112.github.io/drivelens/#lang=zh)**，切换到 **OAuth 账号登录** 标签页，填入相册链接与您的 Client ID，点击 **授权并打开相册**。
   - 拥有文件夹 **编辑者（Editor）** 权限的协作者会自动将评分、标签和批注同步至相册内的 `.drivelens/` 目录；**查看者（Viewer）** 权限则可正常看图并在本地暂存评分。
   - 将以下一键直达链接发给已加入测试用户的朋友，对方点击授权即可加入协同选片：
     ```text
     https://afs112.github.io/drivelens/#folder=<FOLDER_ID>&client_id=<YOUR_CLIENT_ID>&lang=zh
     ```

---

## 3. 快速自部署（1 分钟拥有专属域名或局域网版）

DriveLens 采用浏览器原生 ES Modules，**零构建步骤、无需安装 Node.js 或 npm**。

### 方案 1：1 步 Fork + GitHub Pages 托管

1. Fork 本仓库到您的 GitHub 账号。
2. 进入仓库 **Settings → Pages → Build and deployment → Deploy from a branch**，分支选择 **`main`**、目录选择 **`/ (root)`** 并保存。
3. 等待数十秒即可通过 `https://<您的用户名>.github.io/drivelens/` 访问（仓库已内置 `.nojekyll` 与相对 `./` PWA 作用域）。
4. 若使用 OAuth 模式，请将 `https://<您的用户名>.github.io`（同样仅填 Origin，不带 `/drivelens`）添加到 Google Cloud 的 **已获授权的 JavaScript 来源**。

### 方案 2：Cloudflare Pages / Netlify Drop

- **Cloudflare Pages**：关联仓库或直接上传项目目录，**构建命令留空**，输出目录填 `.`。
- **Netlify Drop**：将 `drivelens` 文件夹直接拖入 [Netlify Drop](https://app.netlify.com/drop) 即可生成 HTTPS 链接。

### 方案 3：本地电脑或局域网运行（`start.bat` / `python serve.py`）

仅需 **Python 3**：

- **Windows 一键启动**：双击仓库根目录的 [`start.bat`](start.bat)，会自动启动本地服务并打开 `http://localhost:5173`。
- **macOS / Linux / 命令行**：
  ```bash
  python serve.py
  # 指定端口并自动打开浏览器
  python serve.py 8080 --open
  # 端口绑定自检
  python serve.py 5173 --dry-run
  ```
- **本地服务端额外福利**：[`serve.py`](serve.py) 不仅自动修正 ES Module 与 PWA 的 MIME 类型，还内置轻量 `/api/meta` 接口——局域网内访问同一台 `serve.py` 的朋友即使在 **API Key 模式** 下也能自动将评分与标签同步到 `.local-meta/`！

---

## 4. 实用操作指南与快捷方式速查

### 看图视图与多模态搜索

- **三种画廊布局**：右上角切换 **等高排版（Justified）**、**瀑布流（Waterfall，`V`）** 与 **方形网格（Grid）**；可在 `...` 菜单滑动调节缩略图大小，或在桌面端按住 `Ctrl/Cmd + 滚轮`、移动端双指捏合实时缩放卡片。
- **多模态搜索胶囊**：点击顶部搜索框输入文件名、相机型号、日期或批注关键词，并可叠加 **媒体类型**、**构图比例**、**星级**、**标签** 与 **协作者** 筛选胶囊。
- **文件夹与演示成员切换**：点击左上角展开 **文件夹** 抽屉（支持“包含子文件夹”）。演示模式下点击左上角相册胶囊即可在 **我（Alex）**、**Lin**、**Jay** 之间切换视角或 **重置演示**。

### 打分、贴标签与右键快捷菜单

- **快速选片**：点击照片聚焦后，按 `1–5` 打星、`0` 清除、`F` 收藏、`T` 快速贴标签；按 `I` 开关右侧 **信息检查器** 查看相机 EXIF 参数与写批注。
- **右键快捷菜单**：在画廊或 **大图 Lightbox** 内**右键点击任意照片**，即可直接弹出快捷菜单进行 `1–5★` 打星、收藏、贴标签或下载原图，全程可纯鼠标操作。

### 多选与悬浮批量操作条

- **桌面端**：鼠标悬停在照片卡片**左上角约 `200ms`**，勾选框会自动显现方便单手勾选；也支持 `Ctrl/Cmd + 单击` 复选、`Shift + 单击` 区间连选、`Ctrl/Cmd + A` 全选当前可见照片。
- **移动端 / 触控**：**长按**任意照片（或点击顶部 **选择** 按钮）进入多选模式，底部会浮现液态玻璃批量操作条。

### 拖拽照片到电脑桌面直接下载原图（Chrome / Edge）

- 在桌面端 Chrome 或 Edge 浏览器中，**按住任意照片卡片直接拖拽到电脑桌面**（或访达 / 资源管理器文件夹中），即可自动保存原图文件（基于 `DownloadURL` 协议，Drive 模式下由 Service Worker 接管拉取原图）。

### 极简无感退出大图（Lightbox）与手势

- **桌面端**：
  - **原地轻点退出**：点击照片进入大图后，**鼠标不移动（`< 30px`）直接再点一下**即可立刻退出大图！
  - **点暗色背景 / 下拉 / 按键**：移动鼠标后点击图片外的**暗色背景空白处**、向下拖拽，或按 `Esc` / `Space` / `Enter` 均可退出。
  - **放大与翻页**：移动鼠标到照片上**双击**可切换 `100% / 200%` 缩放（滚轮也可缩放），`←` / `→` 切换上一张/下一张。
- **移动端**：
  - 在大图界面**向上轻扫或向下轻拉**，或直接触发**手机系统侧边返回手势**即可流畅退出并留在相册当前位置。
  - 左右滑动翻页，双击（`1x ↔ 2x`）或双指捏合（`1x–3x`）缩放，单指拖动查看细节。

### 右上角同步状态指示器与刷新

- **红色 `!` 徽标**：表示存在未同步成功的修改或云端同步失败——点击同步按钮即可立即重试同步。
- **琥珀色 `!` 徽标**：表示当前为只读权限或静态站点 API Key 模式，您的评分和批注已安全保存在**当前浏览器本地**。
- **普通刷新 vs 强制全量扫描**：直接点击 **刷新** 会执行极速增量检查；**`Shift + 单击`** 刷新可强制执行全相册重新扫描。

### 2–4 张同屏对比（`C`）与导出精选

- **同屏对比（`C`）**：多选 `2–4` 张照片后按 `C`，即可开启并排或 2×2 网格对比视图，支持 **同步放大（`1x–3x`）与同步拖拽平移**，并可在每个窗格内直接打星、收藏和贴标签。
- **导出精选（Export）**：点击顶栏（或 `...` 菜单中的）**导出**，可勾选 **仅导出精选（平均分 ≥ 4★ 或已收藏）** 以及 **去除文件扩展名**（方便在 Lightroom / Capture One 中按文件名筛选 RAW），支持一键复制文件名列表，或下载 `drivelens-shared-picks.csv`（UTF-8 BOM）与 `drivelens-shared-picks.json`。

### 键盘快捷键一览

> 在搜索框、批注或弹窗输入框打字时，单键快捷键会自动暂停避免误触。

| 快捷键                 | 功能说明                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `←` / `→`              | 上一张 / 下一张（画廊聚焦与大图模式通用）                         |
| `Enter` / `Space`      | 打开 / 退出全屏大图 Lightbox                                      |
| `1` – `5`              | 为当前聚焦或已选中的照片打 **1–5 星**                             |
| `0`                    | 清除我对当前聚焦或已选中照片的评分                                |
| `F`                    | 切换 **收藏（红心）**                                             |
| `T`                    | 打开 **快速贴标签** 弹窗                                          |
| `C`                    | 开启 / 退出 **2–4 张同屏对比**                                    |
| `I`                    | 开关 **信息检查器** 面板（大图内切换详情信息）                    |
| `V`                    | 循环切换画廊视图（**等高排版 / 瀑布流 / 网格**）                  |
| `Ctrl + A` / `Cmd + A` | 全选当前筛选结果中的所有可见照片                                  |
| `Esc`                  | 依次关闭弹窗 → 同屏对比 → 大图 → 侧边栏 → 清除多选                |
| `?`                    | 打开快捷键帮助弹窗                                                |

---

## 5. 安装为桌面 / 手机独立 App（PWA）与零凭据安全保障

### 安装为独立应用（PWA）

在任意 HTTPS 部署地址（如 `https://afs112.github.io/drivelens/#lang=zh`、GitHub Pages、Cloudflare Pages、Netlify Drop）以及本地 `http://localhost` / `127.0.0.1` 下会自动激活 Service Worker（[`sw.js`](sw.js)）与 PWA 安装：

- **桌面端 Chrome / Edge**：点击顶栏的 **安装应用** 按钮，或点击浏览器地址栏右侧的安装图标。
- **iOS / iPadOS Safari**：在 Safari 打开在线地址后，点击底部分享图标 → **添加到主屏幕**。
- **Android Chrome**：在浏览器菜单中选择 **安装应用** 或 **添加到主屏幕**。

### 记住凭据、自动重连与零秘密保证

- **自动重连**：连接弹窗默认勾选 **记住登录凭据并自动重连**。刷新或重新打开 PWA 会自动恢复上次相册；OAuth 的 1 小时临时令牌过期后，仍会保留邮箱提示以便一键重新授权。
- **一键清除**：在连接弹窗随时点击 **清除已保存凭据** 即可抹除本地保存的 API Key、Client ID、Token 与最近相册记录；点击 **清除缓存** 可清空本地相册与缩略图缓存。
- **零秘密仓库保证**：本仓库**不包含任何** API Key、OAuth Client ID、文件夹 ID、邮箱或本地密钥（[`src/constants.js`](src/constants.js) 仅含空字符串默认值，[`.gitignore`](.gitignore) 明确屏蔽 `config*.js`、`.env*`、`*credentials*`、`*secret*` 与 `.local-meta/`）。

---

## 6. 设计灵感与独立性声明（Design Inspiration & Independence）

- **UX 灵感致敬**：DriveLens 的暗房级视觉配色、高效键盘打分流（`1–5`、`0`、`F`、`T`）以及多图并排对比交互体验灵感源自 [julyx10/lap](https://github.com/julyx10/lap)。
- **完全独立项目**：DriveLens 从零独立设计与编写，是一款纯前端原生 Web 应用，专为 **Google Drive** 共享文件夹的零安装浏览器/PWA 看图与多人无冲突协同选片而打造。

---

## 延伸阅读（开发者文档）

- 欢迎查阅 [ARCHITECTURE.md](ARCHITECTURE.md) 了解模块依赖图、10 万级虚拟化与分级缩略图管线、纯 [`src/i18n.js`](src/i18n.js) 国际化架构、PWA 与 Service Worker 缓存策略（[`sw.js`](sw.js)）、Google Drive 增量同步与无冲突 `.drivelens/` / `/api/meta` 数据协议，以及自动化校验套件（[`verify_project.py`](verify_project.py)）。
