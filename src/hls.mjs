// HLS / 图片反向代理：绕过防盗链、重写 m3u8 内部分片地址
import { Readable } from 'node:stream';
import { fetchT, absUrl, b64u } from './util.mjs';

function onlyHttp(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

export function proxyUrlFor(abs, referer) {
  return `/api/hls?u=${b64u.encode(abs)}&r=${b64u.encode(referer || '')}`;
}

/**
 * 直连模式：媒体分片不再经服务器转发，直接让浏览器去 CDN 拉。
 *
 * 为什么值得开：开公网之后，每一个观众的视频流量都要从服务器过一遍。
 * 一台 1 核 2G 的小机器上行只有几 Mbps，两三个人同看就满了。
 * 分片直连之后，服务器只负责 API 的 JSON 和 m3u8 重写（每次几 KB），
 * 视频流量走 CDN，带宽压力直接降到几乎为零。
 *
 * 凭什么能直连：hls.js 用 fetch/XHR 拉分片，跨域要求目标回
 * Access-Control-Allow-Origin。不少采集源 CDN 是 *，但并非全部，
 * 所以这里先探一次（结果按 host 缓存），只有确认带 CORS 的才放直链，
 * 其余仍然代理 —— 宁可多花流量，不能放不出。
 *
 * 开关：环境变量 ANIHUB_DIRECT=1（默认关，本地用不着）。
 */
export const DIRECT = process.env.ANIHUB_DIRECT === '1';

const corsCache = new Map(); // host -> { ok, at }
const CORS_TTL = 6 * 60 * 60 * 1000;

async function hostAllowsCors(url, referer) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const hit = corsCache.get(host);
  if (hit && Date.now() - hit.at < CORS_TTL) return hit.ok;

  let ok = false;
  const probe = async (withRef) => {
    try {
      // 只要两个字节，够看响应头了
      const r = await fetchT(url, {
        timeout: 5000,
        headers: { Range: 'bytes=0-1', ...(withRef && referer ? { Referer: referer } : {}) },
      });
      const acao = r.headers.get('access-control-allow-origin') || '';
      const hit = acao === '*' || (acao && acao.includes(host));
      try {
        await r.body?.cancel();
      } catch {}
      return Boolean(hit);
    } catch {
      return false;
    }
  };
  // 带 Referer 试一次，不行再裸试一次 —— 有的 CDN 见到陌生 Referer 就不给 CORS 头
  ok = await probe(true);
  if (!ok && referer) ok = await probe(false);
  corsCache.set(host, { ok, at: Date.now() });
  return ok;
}

/** 媒体分片（非 m3u8）在直连模式下应不应该走原始地址 */
function directCandidate(abs) {
  if (!DIRECT) return false;
  return /\.(ts|m4s|mp4|aac|m4a|key)(\?|$)/i.test(abs);
}

export async function rewritePlaylist(text, base, referer) {
  const lines = text.split(/\r?\n/);
  const out = [];

  // 先找出一个分片样本，用来判断这个 CDN 给不给跨域
  let sample = null;
  if (DIRECT) {
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const abs = absUrl(t, base);
      if (directCandidate(abs)) {
        sample = abs;
        break;
      }
    }
  }
  const canDirect = sample ? await hostAllowsCors(sample, referer) : false;

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      out.push(line);
      continue;
    }
    if (t.startsWith('#')) {
      if (t.includes('URI="')) {
        out.push(
          line.replace(/URI="([^"]+)"/g, (_m, u) => {
            const abs = absUrl(u, base);
            // 加密密钥也吃 CORS，同样按探测结果决定
            if (canDirect && directCandidate(abs)) return `URI="${abs}"`;
            return `URI="${proxyUrlFor(abs, referer)}"`;
          }),
        );
      } else {
        out.push(line);
      }
      continue;
    }
    const abs = absUrl(t, base);
    // 子 playlist 仍然走代理：它要重写一次，而且体积很小
    if (canDirect && directCandidate(abs)) {
      out.push(abs);
    } else {
      out.push(proxyUrlFor(abs, referer));
    }
  }
  return out.join('\n');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

export async function hlsHandler(req, res, u, referer) {
  if (!onlyHttp(u)) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('bad url');
  }
  let upstream;
  try {
    upstream = await fetchT(u, {
      timeout: 20000,
      headers: {
        ...(referer ? { Referer: referer } : {}),
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('upstream error: ' + String(e.message || e));
  }
  if (!upstream.ok) {
    res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('upstream ' + upstream.status);
  }

  const ct = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl|x-mpegURL/i.test(ct) || /\.m3u8(\?|$)/i.test(u);

  if (isPlaylist) {
    const text = await upstream.text();
    const body = text.includes('#EXTM3U') ? await rewritePlaylist(text, u, referer) : text;
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=8',
    });
    return res.end(body);
  }

  const headers = {
    ...CORS,
    'Content-Type': ct || (/\.ts(\?|$)/i.test(u) ? 'video/mp2t' : 'application/octet-stream'),
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
  };
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) headers[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

// 海报内存缓存：命中直接吐字节，省掉一次回源往返
const imgCache = new Map();
const IMG_MAX = 220;
const IMG_TTL = 3 * 3600_000;
const IMG_MAX_BYTES = 600_000;
// 单张限了还不够，总量也得压住，不然刷一会儿就把内存堆满了
const IMG_BUDGET = 40 * 1024 * 1024;
let imgBytes = 0;

function dropImg(k) {
  const v = imgCache.get(k);
  if (!v) return;
  imgBytes -= v.buf.length;
  imgCache.delete(k);
}

function putImg(k, entry) {
  const old = imgCache.get(k);
  if (old) {
    imgBytes -= old.buf.length;
    imgCache.delete(k);
  }
  imgCache.set(k, entry);
  imgBytes += entry.buf.length;
  while (imgCache.size > IMG_MAX || imgBytes > IMG_BUDGET) {
    const first = imgCache.keys().next().value;
    if (first === undefined || first === k) break;
    dropImg(first);
  }
}

/** 预热一张海报进内存缓存（服务启动后补图用） */
export async function warmImage(u) {
  if (!onlyHttp(u)) return;
  if (imgCache.has(u)) return;
  try {
    const r = await fetchT(u, {
      timeout: 9000,
      headers: { Referer: new URL(u).origin + '/', Accept: 'image/*,*/*' },
    });
    if (!r.ok) return;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(ct)) return;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > IMG_MAX_BYTES) return;
    putImg(u, {
      buf,
      ct,
      etag: `W/"${buf.length.toString(16)}-${u.length.toString(36)}"`,
      exp: Date.now() + IMG_TTL,
    });
  } catch {}
}

export async function imageHandler(req, res, u, referer) {
  if (!onlyHttp(u)) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('bad url');
  }

  const hit = imgCache.get(u);
  if (hit && hit.exp > Date.now()) {
    imgCache.delete(u);
    imgCache.set(u, hit);
    res.writeHead(200, {
      ...CORS,
      'Content-Type': hit.ct,
      'Content-Length': hit.buf.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      ETag: hit.etag,
    });
    return res.end(req.method === 'HEAD' ? undefined : hit.buf);
  }

  try {
    const upstream = await fetchT(u, {
      timeout: 15000,
      headers: { Referer: referer || new URL(u).origin + '/', Accept: 'image/*,*/*' },
    });
    if (!upstream.ok) {
      res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'text/plain' });
      return res.end('upstream ' + upstream.status);
    }
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await upstream.arrayBuffer());
    const etag = `W/"${buf.length.toString(16)}-${u.length.toString(36)}"`;

    if (buf.length > 0 && buf.length <= IMG_MAX_BYTES) {
      putImg(u, { buf, ct, etag, exp: Date.now() + IMG_TTL });
    }

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...CORS, ETag: etag, 'Cache-Control': 'public, max-age=604800, immutable' });
      return res.end();
    }

    res.writeHead(200, {
      ...CORS,
      'Content-Type': ct,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800, immutable',
      ETag: etag,
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
    res.end('img error');
  }
}
