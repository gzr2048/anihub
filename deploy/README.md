# 租一台服务器，让它 7×24 跑

电脑关机站就没了，要一直在线就得把服务放到**不会关机的机器**上。这里有两条实际可走的路。

---

## 路线 A：云服务器（推荐）

找一台最便宜的 Linux 小机器，装完就不用管了。

### 选机器

| 在哪买 | 配置 | 价格 | 适合 |
| --- | --- | --- | --- |
| Oracle Cloud 永久免费 | 4 核 24G ARM / 1 核 1G x86 | ¥0 | 够用，但要信用卡验证，偶尔回收闲置实例 |
| 腾讯云 / 阿里云 轻量 | 2 核 2G，3–5M 带宽 | ¥60–120 / 年（新人价） | 国内访问快，需要域名备案 |
| RackNerd / 搬瓦工 | 1 核 1G，1T 流量 | $10–20 / 年 | 便宜，海外线路 |
| 任意 VPS | 1 核 1G 起步 | — | 1G 内存就够，程序堆上限 256M |

**内存不是瓶颈，带宽才是。** 这一点很关键，下面「省流量」一节讲。

系统选 **Ubuntu 22.04 / 24.04**（脚本按 Debian 系写的）。

### 三步装好

**1. 把 anihub 目录传上去**（在自己电脑上执行）

```bash
scp -r anihub root@你的服务器IP:/root/
```

Windows 上直接用 `scp`（Win10+ 自带），或者装个 WinSCP 拖上去。

**2. 上去跑脚本**

```bash
ssh root@你的服务器IP
cd /root/anihub
bash deploy/setup.sh /root/anihub
```

脚本会做这些事，全程约 1 分钟：

```
装 Node 22（已装且 >= 20 则跳过）
建 anihub 系统用户（nologin，不能登录）
代码同步到 /opt/anihub
生成访问口令，写进 /opt/anihub/.env（权限 600）
写好 systemd 服务并开机自启
起服务，轮询 /api/health 确认活着
打印你的分享链接
```

跑完会打印：

```
  口令：   AbC123xyz...
  分享链接： http://1.2.3.4:7788/?t=AbC123xyz...
```

**3. 把这条链接发给朋友**

第一次打开种 30 天 Cookie，之后不用再输口令。

### 常用命令

```bash
systemctl status anihub      # 看状态
journalctl -u anihub -f      # 跟日志
systemctl restart anihub     # 重启
```

改口令：编辑 `/opt/anihub/.env` 里的 `ANIHUB_TOKEN`，然后 `systemctl restart anihub`。旧 Cookie 立刻失效。

更新代码：改完本地文件重新 `scp` 上去，再跑一遍 `setup.sh`（幂等，会保留口令），或者手动 `rsync` 后 `systemctl restart anihub`。

### 想要 HTTPS 和域名

上面装完是 `http://IP:7788`，能用但有两个毛病：浏览器可能提示不安全、口令在明文 HTTP 里传。

有域名就装 Caddy，自动签证书：

```bash
# 装 Caddy（官方源）
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# 用仓库里的配置（先改域名）
cp /root/anihub/deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/anime.example.com/你的域名/' /etc/caddy/Caddyfile
systemctl reload caddy
```

域名 A 记录指向服务器 IP，Caddy 自己申请续期证书。之后访问 `https://你的域名/?t=口令`。

配置里有个容易忽略的点：

```
reverse_proxy 127.0.0.1:7788 {
    flush_interval -1
}
```

`flush_interval -1` 是关掉缓冲。不写的话 Caddy 会攒一批数据再发，视频起播要卡好几秒。代理视频流这个参数必须有。

---

## 省流量：开了直连，带宽压力掉一半以上

这是上服务器之前最该知道的事。

默认情况下每个分片都从服务器过一遍，一个观众 1080P 就是 1–2 Mbps 上行。家用宽带上行 20–30 Mbps，三四个人同时看就满了；便宜的 VPS 更是几 Mbps 就顶。

`ANIHUB_DIRECT=1`（`setup.sh` 默认就写进 `.env`）打开后：

```
m3u8      仍然经服务器 → 因为要重写里面的地址，但一个文件才几 KB
媒体分片  浏览器直接去 CDN 拉 → 服务器零流量
```

凭什么能直连：hls.js 用 fetch 拉分片，只要 CDN 回 `Access-Control-Allow-Origin` 就行。程序会先探一次（按域名缓存 6 小时），**只有确认带 CORS 的才放直链，不带的自动退回代理**，所以不会出现放不出来的情况。

实测 7 个源：

| 源 | 结果 | CDN |
| --- | --- | --- |
| 量子 | **366 分片全直连** | `v.cdnlz17.com` / `v.lzcdn31.com` |
| 非凡 | **359 分片全直连** | `vip.ffzy-plays.com` |
| 360 | **715 分片全直连** | `vod1.maowushi.com` |
| 无尽 | 727 全代理 | 不给 CORS |
| 北斗 | 713 全代理 | 不给 CORS |
| 最大 | 726 全代理 | 不给 CORS |

也就是约一半的源能省掉媒体流量。关掉的话把 `.env` 里那行注释掉重启即可。

---

## 路线 B：不租服务器，用 Cloudflare Tunnel

如果只是三五个人看、自己电脑也不是天天关，可以用隧道把家里这台暴露出去。零成本，但**电脑必须开着**——不满足「不用开着」的前提，列在这里只是作对比。详见上一层的 `DEPLOY.md`。

---

## 几个要提前知道的

**链接给出去就收不回来。** 要收回只能换口令重启，所有人重新拿链接。

**被抓到会怎样。** 站点本身不存视频，但公网传播这类内容确实有风险。口令 + 反收录能降低被发现的概率，不是保护伞。自己判断。

**免费机器会回收。** Oracle 的免费实例长期低负载可能被回收，账号也可能因为「用途异常」被停。重要的东西别只放这一台。

**流量超了会限速。** 国内轻量云一般给 1–3T/月，海外便宜 VPS 给 1T 左右。开了直连之后，服务器只跑 API，正常看片很难跑满。
