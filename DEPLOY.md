# 部署到公网 + 不被搜索到

目标：朋友点一个链接就能看，但搜索引擎找不到，陌生人猜不到。

分两件事——**怎么把它放到公网**，和**怎么让它不被索引**。后者代码里已经做完了，前者要你在自己机器上跑几条命令。

---

## 一、选哪条路

| 方案 | 成本 | 需要公网 IP | 地址固定 | 适合 |
| --- | --- | --- | --- | --- |
| **Cloudflare Tunnel 快速隧道** | 免费 | 不用 | 每次重启换 | 发链接给几个朋友看几天 |
| **Cloudflare Tunnel 固定子域** | 免费（要有域名） | 不用 | 固定 | 长期分享，推荐 |
| ngrok | 免费版有限制 | 不用 | 免费版每次换 | 临时演示 |
| 云服务器 + 域名 | 几十块/月 | 要 | 固定 | 想 7×24 跑，不想开着自己的电脑 |

自己电脑当服务器，关机就没了；想常开就上云。下面按 **Cloudflare Tunnel** 写，因为它免费、不需要公网 IP、自带 HTTPS，也不用在路由器上开端口。

> **不想开着自己电脑？** 见 [deploy/README.md](deploy/README.md)：一条命令在云服务器上装成 systemd 服务，附带省流量的直连模式说明。

---

## 二、先设访问口令（重要）

不设口令的话，链接一旦流出去，任何人都能看，还会用你的机器当免费代理。

Windows 下临时设：

```bat
set ANIHUB_TOKEN=换成你自己的长口令-越乱越好
node server.mjs
```

想长期生效就写进 `start.bat`，在 `set "PORT=7788"` 那行附近加一行：

```bat
if not defined ANIHUB_TOKEN set "ANIHUB_TOKEN=换成你自己的长口令"
```

生成一个够乱的口令：

```bat
node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"
```

设好之后：

- 直接访问 → 弹一个输入口令的页面
- 带 `?t=口令` 访问 → 记住 30 天，然后地址栏里的口令自动消失
- **分享链接就是 `https://你的地址/?t=口令`**，朋友点一次以后就不用再输

口令存在 `HttpOnly` Cookie 里，前端 JS 读不到，也不进 URL 历史（第一次访问后前端会 `history.replaceState` 擦掉）。

---

## 三、Cloudflare Tunnel

### 快速隧道（两分钟，地址每次重启都变）

```bat
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:7788
```

窗口里会打出类似：

```
https://shiny-panda-abc123.trycloudflare.com
```

把它和口令拼起来发出去：

```
https://shiny-panda-abc123.trycloudflare.com/?t=你的口令
```

关掉窗口隧道就断。地址是随机英文单词，不会被扫到，但也别公开贴。

### 固定子域（要有域名，托管在 Cloudflare）

```bat
cloudflared tunnel login
cloudflared tunnel create anihub
cloudflared tunnel route dns anihub anime.你的域名.com
cloudflared tunnel run --url http://127.0.0.1:7788 anihub
```

之后每次 `cloudflared tunnel run anihub` 就是同一个地址。

想开机自启（管理员 PowerShell）：

```bat
cloudflared service install
```

### 再上一层：Cloudflare Access（连口令都省了）

Zero Trust → Access → Applications → Add an application → Self-hosted：

- 域名填 `anime.你的域名.com`
- Policy 选 `Allow`，条件 `Emails` 填你朋友的邮箱
- 登录方式选 One-time PIN

这样访问会先要求邮箱验证码，只有白名单里的邮箱进得来。免费版 50 个用户。**这是最稳的"不给外人看"方案**，搜索引擎更不可能进来。

---

## 四、反收录：代码里已经做了四层

| 层 | 位置 | 作用 |
| --- | --- | --- |
| `robots.txt` | `public/robots.txt` | `Disallow: /`，规矩的爬虫看到就掉头 |
| `<meta name="robots">` | `public/index.html` | `noindex, nofollow, noarchive, nosnippet` |
| `X-Robots-Tag` | `src/access.mjs` 的 `applySecurityHeaders()` | **每个响应**都带，包括 API、图片、m3u8，漏网的页面也盖住 |
| 访问口令 / Access | 同上 | 爬虫连 HTML 都拿不到，只有 401 |

外加：

- `Referrer-Policy: no-referrer` —— 页面跳到外部片源时不泄露你的地址
- `X-Frame-Options: SAMEORIGIN` —— 不许别人用 iframe 套你的站
- 没有 `sitemap.xml`，没在任何地方提交过

**注意**：`robots.txt` 只是"请求"爬虫不要来，不守规矩的一样会抓；真正的门槛是口令。`noindex` 也需要爬虫先能访问到才生效——现在它连 401 都过不去，反而更干净。

---

## 五、别做的事

- 不要在微博/贴吧/群公告里贴链接。搜索引擎抓不到，但人能看到，转几次就散了。
- 不要用 `anihub`、`anime` 这种一眼就知道的固定子域做快速隧道（快速隧道本来就是随机的，正好）。
- 不要在分享链接里带 `?t=` 之外的标识（比如 `#/p/lz/10600`），让人自己点进去就行。
- Cloudflare 面板里别开 "Always Online"、"Rocket Loader" 之类会改写页面或缓存内容的功能。

---

## 六、加固了什么（因为 /p 会暴露在公网）

`/p` 是代替浏览器去抓外链的转发器。公网一开，它就等于一个开放代理，所以 `src/proxy.mjs` 加了三条：

1. **不许打内网**——目标域名先做 DNS 解析，落到 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（云元数据）、`::1`、`fc00::/7`、`fe80::/10` 一律 403。防的是有人拿它探你局域网和云主机元数据。
2. **单次最多 64MB**——先看 `Content-Length`，没有就边转发边计数，超了直接断。原来是整个读进内存，一个 2G 的文件就能把进程顶死。
3. **同时最多 32 条转发**——超了返回 503 `Retry-After: 1`，防止被人当带宽跳板刷。

实测：

```
正常 m3u8 转发          200
http://127.0.0.1:7788   403
http://localhost:7788   403
http://169.254.169.254  403
http://192.168.1.1      403
```

---

## 七、成本与风险

- **流量走你的宽带**。一个 1080P 观众大概 1–2 Mbps，五个人同时看就是 5–10 Mbps 上行。家用宽带上行通常只有 20–30 Mbps，别指望能带很多人。
- **电脑得开着**。休眠、断网、重启都会断。
- **片源本身可能挂**。站里会自动换线，但全挂了就是全挂了。
- **链接一旦给出去就收不回来**。想收回只能换口令（改 `ANIHUB_TOKEN` 重启，旧 Cookie 全部失效）。

真要长期跑，租个 1 核 2G 的小服务器（月付二三十），把 `anihub` 目录和内置的 `runtime/node.exe` 拷上去，用 `nohup node server.mjs &` 起，前面套一层 Caddy 或 Nginx 做 HTTPS，再配上面同样的口令。Windows 的那套 bat 就不用了。
