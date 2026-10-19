# ANIHUB · 全网番剧聚合站

站内直连播放的番剧聚合站点：从多个公开采集接口（macCMS V10 协议）实时抓取片库，服务端解析播放地址、代理 m3u8 与分片，浏览器里点开就播，不跳外链、不留中间页。

当前接入 7 个采集源，合计约 6.7 万条番剧条目（国产 / 日韩 / 欧美 / 漫剧）。

## 启动

```bash
cd anihub
node server.mjs                  # 默认 http://127.0.0.1:7788
node server.mjs --port 8080      # 指定端口
PORT=8080 node server.mjs        # 环境变量也行
ANIHUB_CACHE=0 node server.mjs   # 关闭落盘缓存，每次全量回源
```

Windows 直接双击 `start.bat`：它会先看 7788 是不是被上一个没关干净的 ANIHUB 占着，是的话结束掉再启动，然后自动开浏览器。想指定端口就 `start.bat 8080`。关服务双击 `stop.bat`（只杀 node 进程，别的程序占着端口不动）。

零依赖，只需要 Node 18+（本项目在 Node 24 上验证）。

**端口冲突**：没显式指定端口时，7788 被占会自动顺延到 7789、7790，最多试 10 个；显式指定了就直接报错并告诉你占用进程的 PID 和结束命令，不会偷偷换端口骗你。

```bash
node server.mjs --port 8080     # 被占时这样收场：
#   ✗ 端口 8080 已经被占用了。
#     占用进程 PID 12345
#     结束它：  taskkill /PID 12345 /F
```

启动预热：静态资源进内存 → 首页聚合 → 首屏海报 + 分类页/热门词。聚合结果落盘到 `data/cache.json`，第二次启动直接读回来：

```
cache restored: 11 条（2 分钟前）
warm home: 146 张卡片 / 7 源 / 0ms      # 冷启动 2347ms
warm lists: 4 分类 + 5 关键词 / 34ms     # 冷启动 8221ms
warm posters: 24/24 in 2120ms
```

预热是后台跑的，不挡着接请求。缓存带 TTL，过期后还会用 stale-while-revalidate 先给旧值、后台刷新。想强制全新抓一遍，删掉 `data/cache.json`。

## 打包分享

一个命令产出能直接发给别人的压缩包：

```bash
bash tools/pack.sh        # 带内置 Node 运行时 → dist/ANIHUB-runtime-1.0.0-win64.zip（34MB）
bash tools/pack.sh -n     # 轻量包，对方自己装 Node 18+ → dist/ANIHUB-1.0.0-win64.zip
```

解压后就是这份代码本身加一个 `runtime/` 目录，对方双击 `start.bat` 即可，什么环境都不用装。

`start.bat` 会做的事：

1. 优先用包里自带的 `runtime\node.exe`，没有才找系统的 `node`
2. 打印启动信息，把端口和关闭方式写清楚
3. 端口被占时先看占用者是不是自己（`node.exe`）：是就结束它再启动，不是就自动换下一个空闲端口
4. 起 `server.mjs`（`--max-old-space-size=192`，把堆钉死在 192MB），由服务端打印真正的启动 banner
5. 服务退出后停住窗口等按键，不会一闪就没

### 对方双击 bat 被 Windows 拦

从网上下载的 zip 里每个文件都带 Mark-of-the-Web（`Zone.Identifier` 数据流），双击 bat 会弹「Windows 已保护你的电脑」。这是标记问题，不是代码问题，三种走法：

1. 点「更多信息 → 仍要运行」，能用但每次都弹
2. **推荐**：解压前右键 zip → 属性 → 勾「解除锁定」→ 确定 → 再解压，解压出来的文件都不带标记
3. 已经解压了：直接点「仍要运行」，`start.bat` 首次运行会用 `dir /r` 探测自己身上的 `Zone.Identifier`，探到就 `Get-ChildItem -Recurse | Unblock-File` 把整目录清一遍，之后不再提示

所以 `start.bat` 开头有这段：

```bat
set "LOCKED="
for /f "delims=" %%a in ('dir /r "%~f0" 2^>nul ^| findstr /c:"Zone.Identifier"') do set "LOCKED=1"
if defined LOCKED (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File | Unblock-File" ...
)
```

用 `dir /r` 而不是 `if exist "%~f0:Zone.Identifier"` —— 后者在 cmd 里对数据流永远返回假，测了半天才发现。

另外 `.ico` 里 16/24/32/48/64/128 必须是 32bpp DIB 条目，只有 256 能用 PNG 压缩。全用 PNG 的话 Windows Shell 渲染不出来，快捷方式会显示成白板 —— `tools/mkicon.mjs` 现在按尺寸分流（`bmp()` 写 BITMAPINFOHEADER + 自底向上 BGRA + AND 掩码）。

不想开着黑窗口的，双击 `创建快捷方式.bat`，桌面会生成一个带粉色播放键图标的 `ANIHUB` 快捷方式，之后双击那个就行。

图标由 `tools/mkicon.mjs` 纯手工生成 —— 用距离场画出圆角三角形，逐像素算渐变和柔光，不依赖任何图形库。改配色调文件顶部的 `ACCENT` / `ACCENT2` 重跑一次即可，同时会更新网页的 `favicon.ico`。

```bash
node tools/mkicon.mjs tools/ANIHUB.ico   # 顺便产出 192/256/512 的 png 预览
cp tools/ANIHUB.ico public/favicon.ico
```

## 手机版（APK）

```
bash android/build.sh          # 产出 dist/ANIHUB-1.0.0.apk（约 258 KB）
```

APK 里**没有 Node**，也不连任何服务器。它做两件事：

1. `android/src/com/anihub/app/LocalServer.java` 在 `127.0.0.1` 起一个只对本机开放的
   微型 HTTP 服务（8 线程，端口从 8899 往上找空的），负责发静态页和 `/p` 转发。
2. 把整套聚合逻辑搬进了浏览器 JS：`public/mobile/core.js` 是 `src/cms.mjs` +
   `catalog.mjs` + `resolver.mjs` 的等价实现，`boot.js` 劫持 `window.fetch`，
   把 `/api/*` 就地转给 core.js 处理，页面代码一行没改。

之所以不能纯前端直连采集站：macCMS 接口不返回 `Access-Control-Allow-Origin`，
浏览器跨域必被拦。所以必须有一个同源的转发口，Android 上就用内置服务顶替。

移动端 UI 复用同一套 `public/`，靠 `@media (max-width: 820px)` 切换：
底部五标签栏（发现/新番/国漫/欧美/漫剧）、搜索与「我的」收进顶栏一行、
播放页视频下方加「上一集 / 第几集 / 下一集」快切条、全屏时顶栏与标签栏自动隐藏。

```
android/
├── build.sh              # 构建脚本（aapt2 → javac → d8 → zipalign → apksigner）
├── AndroidManifest.xml   # minSdk 23 / targetSdk 34 / cleartext / networkSecurityConfig
├── src/com/anihub/app/
│   ├── LocalServer.java  # 本地 HTTP 服务 + /p 转发 + m3u8 改写
│   └── MainActivity.java # WebView 容器、全屏视频、返回键
├── res/                  # 图标（tools/mkandroid.mjs 生成）、主题、网络安全配置
└── assets/app/           # 构建时从 public/ 复制
```

构建依赖：JDK 17、Android SDK build-tools 34、platform android-34。
`build.sh` 里所有传给 Windows 程序的路径都过 `cygpath -w`（MSYS 路径它读不懂），
`d8`/`apksigner` 直接 `java -cp lib/d8.jar` 调用（这两个只有 .bat 包装）。

## 手机版（iPhone）

iOS 没法像 Android 那样发个 apk 让人装——要么 7 天签名过期，要么每年 $99 加一次审核。这里走 **PWA**：Safari 打开地址 → 分享 → 添加到主屏幕，得到图标和全屏，永久有效，不花钱。

**前提是 HTTPS。** `http://192.168.x.x` 加到主屏幕只是个书签，没有全屏。所以这一步和「公网部署」绑在一起（Cloudflare Tunnel 或 VPS + Caddy，两条都有了）。

代码侧的适配：

| 文件 | 做了什么 |
| --- | --- |
| `public/manifest.json` | 名称、图标、`display: standalone`、`orientation: portrait`、主题色 |
| `public/apple-touch-icon.png` | 180×180 **不透明**（iOS 自己加圆角，留透明会透黑），`tools/mkapple.mjs` 生成 |
| `public/index.html` | `apple-mobile-web-app-capable` 等四个 meta + manifest 链接 |
| `public/player.js` | 全屏走 `video.webkitEnterFullscreen()`（iOS 没有 `requestFullscreen`），监听 `webkitbegin/endfullscreen` |
| `public/app.js` | iOS 上跳过 hls.js（省 400KB，Safari 原生能放 m3u8），设置面板里说明清晰度在系统控制条切 |
| `public/styles.css` | 播放区 `touch-action: none` + `-webkit-touch-callout: none`（不然长按弹系统菜单、抢走 3 倍速手势）；`nav` 加 `safe-area-inset-top` 避开灵动岛 |

iOS 上做不到的三件事，都是系统限制：切后台视频会暂停、没有 `document.pictureInPictureEnabled`（画中画按钮自动隐藏，用原生播放器的）、没有 Web Push（除非做推送那套）。

## 目录

```
anihub/
├── server.mjs            # HTTP 服务：静态资源（内存 + gzip/br）、/api 路由、预热、端口处理
├── start.bat             # 双击启动（内置/系统 Node 自动识别 + 清理旧实例 + 开浏览器）
├── stop.bat              # 双击停止
├── 创建快捷方式.bat      # 在桌面生成带图标的快捷方式
├── ANIHUB.ico            # 图标
├── tools/                # pack.sh（打包分享）+ mkicon.mjs（生成图标）+ mkandroid.mjs（生成 APK 图标）
├── data/sources.json     # 采集源配置（权重、分类映射）
├── data/cache.json       # 聚合结果落盘（可删）
├── src/
│   ├── cms.mjs           # macCMS 接口客户端（列表 / 搜索 / 详情）
│   ├── catalog.mjs       # 归一化、跨源合并、首页聚合、搜索聚合、联想、同类推荐
│   ├── resolver.mjs      # 播放页 → m3u8 解析（正则 + 探测）
│   ├── hls.mjs           # m3u8 重写与分片代理、图片代理（含内存缓存）
│   ├── proxy.mjs         # /p 通用转发（手机版 Java 实现的参照物，含内网封锁与体积/并发限制）
│   ├── access.mjs        # 访问口令（ANIHUB_TOKEN）、登录页、反收录响应头
│   ├── api.mjs           # API 分发
│   └── util.mjs          # 缓存（含并发去重 / stale-while-revalidate）、并发、相似度、编码
└── public/               # 前端（原生 ES 模块 + hls.js）
    └── mobile/           # APK 用的浏览器端聚合层（core.js + boot.js）
```

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/config` | 站点信息、源列表、分类 |
| `GET /api/home` | 首页聚合（hero + 日番/国漫/欧美/漫剧四区 + 统计） |
| `GET /api/list?cat=jp&page=1` | 分类列表，多源合并去重 |
| `GET /api/search?q=关键词&cat=jp&page=1` | 全源搜索，同名合并为「其它线路」，可按分类过滤 |
| `GET /api/suggest?q=前缀` | 搜索联想（本地池 + 远端补全） |
| `GET /api/hotwords` | 热门搜索词 |
| `GET /api/detail?key=lz&id=123` | 详情 + 线路 + 剧集 + 其它源备份 |
| `GET /api/related?key=lz&id=123&name=…` | 跨站同名备份 |
| `GET /api/like?name=…&cat=jp` | 详情页「猜你喜欢」 |
| `GET /api/stream?key=lz&id=123&line=0&ep=0` | 解析出可直接播放的 m3u8 |
| `GET /api/hls?u=…&r=…` | m3u8 / ts 分片代理（自动重写相对路径与密钥 URI） |
| `GET /api/img?u=…` | 图片代理（绕过 Referer 防盗链，内存缓存 + ETag） |
| `GET /api/health` | 源存活状态 |

## 播放链路

1. 详情接口给出 `vod_play_url`，形如 `线路A$$$线路B` + `第01集$url#第02集$url`。
2. 若地址本身是 `.m3u8`，直接探测；若是播放页（如 `v.lzcdn31.com/share/xxx`），抓 HTML 用 `var main = "…m3u8"` 等模式提取真实地址。
3. 所有 m3u8 经 `/api/hls` 代理：重写子播放列表、`EXT-X-KEY`、`EXT-X-MAP` 的 URI，透传 Range，前端 hls.js 只管播。
4. 某条线路连不上时，`resolveBest` 会自动轮换到该番剧的其它线路，并在播放器上提示已切换。

## 清晰度

播放器右上角有两个按钮：画中画、播放设置。触屏常显，鼠标移到画面上才显形。

设置面板分四块：

- **倍速** `0.5×`–`3×`，存 `localStorage.ah:rate`，换集换线换番都沿用。
- **清晰度** 线路的 master 播放列表带多个 `EXT-X-STREAM-INF` 时，可选「自动」或具体档位；采集站绝大多数是单码率，这时只有一项并注明「这条线路只有一档」，显示真实分辨率（如 `1080×608`）。档位名按真实宽高给：只有标准 16:9 才叫 `1080P` / `720P`，裁过黑边的直接报 `宽×高`，不糊弄。
- **画面** 原始比例 / 裁切填满 / 拉伸填满，存 `ah:fit`。
- **音量** 滑块存 `ah:vol`；手机上 `video.volume` 控不到系统音量，所以只在桌面显示。

画中画用 `requestPictureInPicture()`，能力探测 `document.pictureInPictureEnabled`，不支持就隐藏按钮。

## 触控手势

手机/平板上单指在视频区域操作，中间有 HUD 提示：

| 手势 | 行为 |
| --- | --- |
| 长按 420ms | 临时 3× 倍速（`player.holdRate(3)`），松手恢复原倍速，不写 localStorage |
| 双击左半 / 右半 | ±10 秒，左右各有一道高亮闪一下 |
| 左半屏上下滑 | 音量，`player.setVolume()` 收尾时落盘 |
| 右半屏上下滑 | 亮度（CSS `filter: brightness()`），**不落盘**，避免下次进来画面还是暗的 |

视频底部 56px 留给原生控制条，手势在那里不介入；鼠标指针（`pointerType === 'mouse'`）完全跳过，桌面不受影响。

## 键盘快捷键

播放页绑定在 `document` 上，四个键：`空格` 播放/暂停、`← →` 快退/快进 5s、`N` 下一集、`F` 全屏、`Esc` 退出全屏。

三个容易踩的坑，都在实现里处理了：

1. **焦点残留**：从搜索框点进详情/播放后，`document.activeElement` 还是那个 `<input>`，所有按键都会被"在输入框里打字"的判断吃掉——表现就是"快捷键时灵时不灵"。`render()` 里对非 `search` 路由统一把焦点还给 `body`。
2. **键位来源**：只认 `ev.code` 在部分键盘/远程桌面/输入法下拿不到值，所以 `code` 和 `key` 双判定（`hit(ev, 'Space', [' ', 'spacebar'])`）。
3. **输入法组合**：中文输入法开着时 keydown 会被 IME 截走（`isComposing` / `keyCode === 229`），这类事件一律不接管，免得把正在拼的字打断。

另外 `← →` 走 `player.nudge(±5)`，跳转夹在 `[0, duration - 0.3]` 内，并触发一次进度上报，不会跳完就丢进度。

## 播放中断怎么办

播放器里所有失败路径都收在一处，按顺序降级，不需要人工干预：

1. hls.js 报致命错误或分片连续拉不到 → 标记当前线路失败，静默换到同一番剧的下一条线路，从断点续播。
2. 本番所有线路都失败 → 调 `/api/related` 找其它资源站的同名番剧，跳过去从同一集继续，并 toast 提示换到了哪个站。
3. 跨站也失败 → 播放器盖一层面板，给「重试全部线路 / 看下一集 / 回详情页」三个出口。

已经跳过的源记在 `sessionStorage` 的 `ah:jumped` 里，避免几个站互相甩锅时来回横跳；任意一次播放成功就清空。

## 我的：进度 / 收藏 / 历史

全部存在浏览器 `localStorage`，不上传服务器：

| 键 | 内容 |
| --- | --- |
| `ah:progress` | 每个番剧的观看进度：集数、线路、秒数、总时长、是否看完、最近时间（上限 60 条，按时间淘汰） |
| `ah:fav` | 收藏列表，含 `remarks` 快照用于判断更新 |
| `ah:stats` | 观看统计：累计秒数、按天秒数（留 60 天）、看过的集去重（留 250 条） |
| `ah:quality` `ah:rate` `ah:vol` `ah:fit` | 播放器偏好：清晰度档位、倍速、音量、画面比例 |

`#/me` 页面把这些拼成四块：继续观看（没看完的，带底部进度条）、观看统计、我的收藏、观看历史（含「已看完」）。入口在导航栏右侧的人像图标。

**追番更新提示**：收藏时记下当时的 `remarks`（更新状态文案，如「更新至第 03 集」）。进「我的」页时并发拉最多 24 部的详情比对，文案变了就写回并给卡片加 `has-new` 类——左上角一道粉色 NEW，更新状态那行也变粉；区块标题变成「1 部 · 1 部有更新」。进详情页时也会顺手对齐快照。

**观看统计**：`onProgress` 里比较 `currentTime` 增量，超过 45 秒的跳跃视为拖进度条、不计入，其余累加到 `ah:stats`。展示本周观看时长、本周追番天数、累计集数、累计时长。

## 更新检查

`data/sources.json` 的 `app` 段：

```json
"app": { "version": "1.0.1", "manifest": "", "download": "", "notes": "" }
```

- `manifest` 填一个远端 JSON 地址（形如 `{"version":"1.0.2","download":"https://..."}`），「我的」页的「检查更新」会拉它比对版本号。
- `download` 直接填下载页地址，没有 manifest 时点按钮就打开它。
- 两个都留空时点按钮会提示去填。APK 模式下 `manifest` 请求自动走 `/p?u=` 代理绕开跨域。

## 性能做法

- 静态文件启动时读进内存，`.html/.css/.js/.json/.svg` 预生成 gzip 与 brotli，按 `Accept-Encoding` 直接吐，带 ETag 与 304。
- 前端没走打包器，所以 index.html 里引用带 `?v=<内容指纹>`（启动时用文件 sha1 前 8 位替换）。带 v 的 js/css 长缓存一年，改文件指纹就变、URL 跟着变；不带 v 的一律 `no-cache` 走 ETag 协商。**改完前端不用叫用户清缓存**。
- 接口响应 >1KB 时 gzip，缓存带 stale-while-revalidate：过期先给旧值，后台刷新。
- 同一 key 的并发请求只回源一次（inflight 去重），避免冷启动打爆源站。
- **hls.js 按需加载**：414KB 的 `hls.min.js` 不再挂在 `index.html` 上，点开某一集时才动态拉，首页零成本。
- **列表接口瘦身**：卡片只要 `key/source/id/name/sub/pic/remarks/year/area/typeName/cat/catLabel/score/weight/alt`，`content`、`actor`、`director` 这些只有详情页用得上的字段留在详情接口里。首页 JSON 从 157KB 降到 47KB，分类列表从 55KB 降到 22KB。
- 海报代理走内存 LRU（220 条 / 3 小时，另有 40MB 总量上限），命中 1ms 级；启动时预取首屏 24 张。
- 卡片封面 `loading="lazy"`，首屏前 8 张 `fetchpriority="high"` 抢先。
- 聚合结果（首页 / 分类 / 搜索 / 联想 / 猜你喜欢）落盘，重启后 1ms 命中；详情与流地址变化快，只放内存。

## 内存占用

本地跑着别把机器吃满，几处都设了硬上限：

| 位置 | 上限 |
| --- | --- |
| 聚合缓存 | 700 条，落盘文件 8MB |
| 海报内存缓存 | 220 张 / 单张 600KB / 合计 40MB，LRU 淘汰 |
| hls.js 播放缓冲 | 前向 20s、最大 40s、回看 30s |
| Node 堆 | `start.bat` 用 `--max-old-space-size=192` 启动 |

实测常驻内存约 77MB（预热完成、首页/分类/搜索都跑过一轮之后）。

## 扩充片源

编辑 `data/sources.json` 追加一条即可，字段：

```json
{
  "key": "abc",
  "name": "某源",
  "api": "https://example.com/api.php/provide/vod/",
  "weight": 70,
  "types": { "jp": [30], "cn": [29], "us": [31] },
  "timeout": 7000
}
```

`types` 里填该源自己的分类 id（可在 `?ac=detail` 返回的 `type_id` 里查）。权重高的源优先作为主线路，其余自动并入「其它线路」。父分类 id 通常返回空列表，要填子分类。

## 公网部署

两条路，按「电脑要不要开着」选：

- **开着电脑**（免费、两分钟）：`DEPLOY.md` —— Cloudflare Tunnel，自带 HTTPS，不需要公网 IP。
- **不用开电脑**（租台小机器常驻）：`deploy/README.md` —— 一条命令装成 systemd 服务，附带 Caddy 反代配置和省流量的直连模式。

代码侧已经就位的：

- **访问口令**：设环境变量 `ANIHUB_TOKEN` 后启用。分享链接写成 `https://地址/?t=口令`，首次访问种 30 天 `HttpOnly` Cookie，然后前端把地址栏里的口令擦掉（保留 `#hash`，所以能直接分享到某一集）。没设口令则完全放行，本地无感。
- **四层反收录**：`robots.txt` 的 `Disallow: /`、`index.html` 的 `<meta name="robots">`、`applySecurityHeaders()` 给**每个响应**加 `X-Robots-Tag`（含 API、图片、m3u8）、以及口令本身让爬虫拿不到 HTML。
- **`/p` 转发器加固**：目标域名必须解析到公网地址（挡 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7` 等），单次上限 64MB（流式计数，不再整块读进内存），并发上限 32 条。公网一开 `/p` 就是个开放代理，这三条是必须的。

## 说明

- 抓取与播放都发生在服务端与本地浏览器之间，站点本身不存储任何视频文件。
- 片库、画质、更新速度取决于采集源；源挂掉时换源或等待恢复。
- 仅供个人学习研究使用。

`ANIHUB_DIRECT=1` 打开媒体分片直连（`deploy/README.md` 里写了原因和实测），确认支持 CORS 的 CDN 让浏览器直接拉，不支持的自动退回代理。
