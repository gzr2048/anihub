// 通用转发：/p?u=<base64url>&r=<base64url>
// APK 版把整套聚合逻辑搬进浏览器后，唯一还需要后端做的事就是「代替浏览器去取」：
// 采集站不带 CORS 头、图床查 Referer、m3u8 内部分片还是相对路径。
// 这个处理器和 android/ 里的 Java 实现一一对应，两边行为要一致。
import { fetchT, absUrl, b64u } from './util.mjs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

// 公网部署时 /p 会被陌生人摸到，这里按"开放代理"来设防：
// 单次最多 64MB、同时最多 32 条转发、目标不许是内网/回环/云元数据地址。
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_INFLIGHT = 32;
let inflight = 0;

function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // ULA
    if (s.startsWith('fe80')) return true; // link-local
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
    return false;
  }
  return true;
}

/** 目标主机必须解析到公网地址，挡掉内网探测和 169.254 元数据 */
async function targetAllowed(target) {
  let host;
  try {
    host = new URL(target).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (isIP(host)) return !isPrivateIp(host);
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return false;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

function tooBig(res, msg) {
  res.writeHead(413, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

export function proxyUrl(u, referer) {
  let s = '/p?u=' + b64u.encode(u);
  if (referer) s += '&r=' + b64u.encode(referer);
  return s;
}

function isPlaylist(text, ct, u) {
  return /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(u) || text.startsWith('#EXTM3U');
}

/** 把 playlist 里的每一段地址换成同样走代理的地址 */
export function rewritePlaylist(text, base, referer) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (t.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxyUrl(absUrl(u, base), referer)}"`);
        }
        return line;
      }
      return proxyUrl(absUrl(t, base), referer);
    })
    .join('\n');
}

function decode(v) {
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  try {
    const d = b64u.decode(v);
    return /^https?:\/\//i.test(d) ? d : '';
  } catch {
    return '';
  }
}

export async function proxyHandler(req, res, url) {
  const target = decode(url.searchParams.get('u'));
  const referer = decode(url.searchParams.get('r'));

  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad url');
  }

  if (inflight >= MAX_INFLIGHT) {
    res.writeHead(503, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
    return res.end('too many concurrent requests');
  }

  if (!(await targetAllowed(target))) {
    res.writeHead(403, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('target not allowed');
  }

  inflight += 1;
  let upstream;
  try {
    upstream = await fetchT(target, {
      timeout: 20000,
      headers: {
        ...(referer ? { Referer: referer } : {}),
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
  } catch (e) {
    inflight -= 1;
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('upstream error: ' + String(e.message || e));
  }

  try {
    const ct = upstream.headers.get('content-type') || '';
    const isM3u8 = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target);

    if (isM3u8) {
      const text = await upstream.text();
      const body = text.includes('#EXTM3U') ? rewritePlaylist(text, target, referer) : text;
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=8',
      });
      return res.end(body);
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) return tooBig(res, 'response too large');

    const headers = { ...CORS, 'Content-Type': ct || 'application/octet-stream' };
    const len = upstream.headers.get('content-length');
    const range = upstream.headers.get('content-range');
    const accept = upstream.headers.get('accept-ranges');
    if (len) headers['Content-Length'] = len;
    if (range) headers['Content-Range'] = range;
    if (accept) headers['Accept-Ranges'] = accept;
    headers['Cache-Control'] = 'public, max-age=86400, immutable';

    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();

    // 流式转发并按累计字节数刹车，防止大文件把内存顶爆
    let sent = 0;
    for await (const chunk of upstream.body) {
      sent += chunk.length;
      if (sent > MAX_BYTES) {
        res.destroy();
        return;
      }
      if (!res.write(chunk)) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('proxy failure: ' + String(e.message || e));
    } else {
      res.destroy();
    }
  } finally {
    inflight -= 1;
  }
}

export { isPlaylist };
