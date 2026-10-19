# 白嫖一台常驻小机器：Render 免费层

先说清楚：**注册账号这一步得你自己来**——要邮箱验证码，有的还要手机号，我没法替你做。除此之外的每一步我都铺好了，你照着点就行。

## 为什么选 Render

| | Render 免费 | Oracle 永久免费 | 国内轻量云 |
| --- | --- | --- | --- |
| 要信用卡 | **不要** | 要（$1 预授权，不扣） | 要 |
| 要实名 | 不要 | 要 | 要 |
| 内存 | 512MB | 最多 24GB | 2GB |
| 你的地址 | `xxx.onrender.com`（带 **HTTPS**） | 只有 IP，要自己配域名 | 只有 IP |
| 会不会睡 | **15 分钟没访问就睡** | 不睡 | 不睡 |
| 费用 | 0 | 0 | 60–120 元/年 |

我这个程序常驻只吃 80MB 内存，512MB 富余得很。**免费层真正的限制是「15 分钟没人访问就休眠」**——第一次打开要等 30 秒左右转圈，之后就快了。想让它一直醒着，看最后一节。

选 Render 的另一个原因：它直接给你一个 `https://` 域名。上一条说的「添加到主屏幕」必须要 HTTPS，这一步它帮你省了。

---

## 第一步：把代码传到 GitHub（网页操作，不用命令行）

1. 打开 https://github.com ，注册或登录
2. 右上角 `+` → **New repository**
3. Repository name 填 `anihub`，选 **Private**（Private 也能部署，别选 Public 把自己的配置暴露出去）
4. 点 **Create repository**
5. 新页面中间有一行「**uploading an existing file**」，点它
6. 打开你电脑上的 `anihub` 文件夹，**把里面的所有东西全选，拖进浏览器**

⚠️ 拖之前先把 `data/cache.json` 删掉（有的话）。这是本地的缓存，带上去没意义，还会让服务器一开始就返回旧数据。

拖完点底部绿色的 **Commit changes**。等几十秒，页面会显示一堆文件，成了。

> 拖文件夹失败的话（有的浏览器不行），改成一个个拖：先拖 `public`、`src`、`data` 三个文件夹，再拖根目录那几个 `.mjs` / `.json` / `.md` / `.txt` / `.bat` / `.ico` 文件。

---

## 第二步：让 Render 把它跑起来

1. 打开 https://render.com ，用 **GitHub 账号直接登录**（不用另注册）
2. 右上角 **New +** → **Web Service**
3. 选 **Build and deploy from a Git repository** → Next
4. 授权 Render 访问你的 GitHub，找到刚建的 `anihub` 仓库 → Connect
5. 下面几个框它一般都自动填好了，对一下：

   | 框 | 填什么 |
   | --- | --- |
   | Name | `anihub`（决定你的域名，想短点就改） |
   | Region | **Singapore**（离国内近） |
   | Runtime | `Node` |
   | Build Command | 留空，或者 `echo ok`（这项目零依赖，不用装包） |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

6. 往下滚到 **Environment Variables**，点 **Add Environment Variable**，加两条：

   | Key | Value |
   | --- | --- |
   | `ANIHUB_TOKEN` | 自己起一个长口令，比如 `anihub-2026-x7k2m9` |
   | `ANIHUB_DIRECT` | `1` |

   第一条是访问口令——**不设的话任何人拿到地址都能看**。第二条是让视频分片直连，免费层流量只有 100GB/月，这个必须开。

7. 点 **Create Web Service**，等构建。日志滚到下面出现这样几行就成了：

   ```
     static warm: 16 files, 744KB raw
     http://0.0.0.0:10000
     warm home: 92 张卡片 / 7 源 / ~2000ms
   ```

8. 页面顶部会显示你的地址，像 `https://anihub-xxxx.onrender.com`

**分享链接** = `https://anihub-xxxx.onrender.com/?t=你的口令`

---

## 第三步：去手机上加上主屏幕

1. 微信里点开这条链接 → 右上角 `…` → **在 Safari 中打开**
2. 底部中间分享按钮 → 往下划 → **添加到主屏幕**
3. 完成。桌面上多个图标，点开全屏播放，没有地址栏。

---

## 免费层的几个脾气

**会休眠。** 15 分钟没人访问就睡，下次访问冷启动 30 秒左右。日志里会重新跑一遍 `warm home`。

**每月 750 小时。** 一个服务 24 小时跑满一个月是 730 小时，刚好够，没有余量同时开第二个。

**磁盘是临时的。** 每次重新部署或重启，本地文件清零。缓存丢了无所谓，但要记住 `data/sources.json` 里你手动改的片源会在重新部署时被 GitHub 上的版本覆盖——想改片源就改 GitHub 上的文件。

**带宽 100GB/月。** 开了 `ANIHUB_DIRECT=1` 之后媒体流量走 CDN 不经服务器，正常看片很难跑满；不开的话几个人看几集就爆了。

---

## 想让它不睡（可选）

Render 免费层靠「有请求」判定活跃。用免费的外部定时 ping 把它叫醒：

1. 打开 https://cron-job.org ，注册（只要邮箱）
2. Create cronjob
3. URL 填 `https://anihub-xxxx.onrender.com/api/health`
4. 执行频率选 **每 10 分钟**
5. Save

`/api/health` 只返回几百字节的 JSON，不耗带宽。

代价：这样一个月就是满 730 小时，750 小时的额度只剩 20 小时余量，重新部署次数多了会被暂停到月底。要是能接受"第一次打开等 30 秒"，就别设，更省。

---

## 出问题看哪里

**页面一直转圈、日志没有 `warm home`** → 采集源连不上。Render 在新加坡，出口正常，多等一会儿或者刷新。

**502 / Application failed to start** → 看日志最后几行。最常见是 `ANIHUB_TOKEN` 没填，但那不会导致启动失败；真失败一般是 `PORT` 冲突或 Node 版本太老，在 Environment 里加 `NODE_VERSION=22` 再部署一次。

**能打开但一片空白** → 浏览器缓存了旧文件，强制刷新（手机上：设置 → Safari → 清除历史记录与网站数据）。这版已经给静态资源加了内容指纹，正常情况下不会再遇到。

**播放提示「线路不可用」** → 单个采集源的问题，换一部或者换一条线路。这跟部署没关系。
