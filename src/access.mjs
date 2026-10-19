/**
 * 公网访问控制 + 反收录
 *
 * ANIHUB_TOKEN 设了才启用口令：
 *   - 带 ?t=<token> 打开一次，种下 Cookie 后重定向（分享给朋友的链接形态）
 *   - 或者在弹出的登录页输入口令
 * 没设就完全放行，本地用不受影响。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const TOKEN = String(process.env.ANIHUB_TOKEN || '').trim();
const COOKIE = 'ah_t';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

export const accessEnabled = Boolean(TOKEN);

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function parseCookie(raw) {
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecure(req) {
  return Boolean(req.headers['x-forwarded-proto']?.includes('https')) || Boolean(req.socket?.encrypted);
}

export function allowed(req, url) {
  if (!accessEnabled) return true;
  const q = url.searchParams.get('t');
  if (q && safeEqual(q, TOKEN)) return true;
  const c = parseCookie(req.headers.cookie || '');
  return Boolean(c[COOKIE]) && safeEqual(c[COOKIE], TOKEN);
}

function cookieHeader(req) {
  const bits = [`${COOKIE}=${encodeURIComponent(TOKEN)}`, 'Path=/', `Max-Age=${MAX_AGE}`, 'SameSite=Lax', 'HttpOnly'];
  if (isSecure(req)) bits.push('Secure');
  return bits.join('; ');
}

/**
 * 用带 ?t= 的链接进来时，把 Cookie 种上。
 * 故意不 302——服务端看不到 #hash，转发会丢掉 SPA 的当前页；
 * 由前端负责把地址栏里的 t 擦掉（见 app.js 顶部）。
 */
export function plantCookie(req, res) {
  if (!accessEnabled) return;
  res.setHeader('Set-Cookie', cookieHeader(req));
}

const PAGE = (err = '') => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow,noarchive" />
<title>ANIHUB · 需要口令</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(120% 90% at 50% 0%, #1a1520 0%, #08090d 62%);
    color: #eceef3; font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .box { width: min(360px, 100%); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .mark {
    width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center;
    background: linear-gradient(140deg, #ff4d7d, #ff8a4c);
  }
  .mark::after {
    content: ''; width: 0; height: 0; margin-left: 3px;
    border-left: 12px solid #12131a; border-top: 7px solid transparent; border-bottom: 7px solid transparent;
  }
  .brand b { font-size: 15px; letter-spacing: .16em; }
  h1 { font-size: 20px; margin: 0 0 6px; font-weight: 600; }
  p { margin: 0 0 20px; color: #8b90a0; font-size: 13px; }
  form { display: flex; gap: 8px; }
  input {
    flex: 1; height: 44px; padding: 0 14px; border-radius: 11px;
    border: 1px solid #2a2c38; background: #101118; color: #eceef3; font-size: 15px;
    outline: none;
  }
  input:focus { border-color: #ff4d7d; }
  button {
    height: 44px; padding: 0 18px; border-radius: 11px; border: 0; cursor: pointer;
    background: linear-gradient(140deg, #ff4d7d, #ff8a4c); color: #17121a;
    font-size: 14px; font-weight: 600;
  }
  .err { margin: 14px 0 0; color: #ff6b8f; font-size: 13px; min-height: 20px; }
  .note { margin-top: 26px; color: #5d6274; font-size: 12px; }
</style></head>
<body><div class="box">
  <div class="brand"><div class="mark"></div><b>ANIHUB</b></div>
  <h1>这个站需要口令</h1>
  <p>找给你链接的人要一个访问口令。</p>
  <form method="post" action="/__auth">
    <input type="password" name="t" placeholder="输入访问口令" autofocus autocomplete="current-password" />
    <button type="submit">进入</button>
  </form>
  <div class="err">${err}</div>
  <div class="note">未收录站点 · 请勿公开传播</div>
</div></body></html>`;

export function gate(req, res, url) {
  // 带 ?t= 的正确口令：种 Cookie 后把 token 从地址栏擦掉（其余参数保留）
  const q = url.searchParams.get('t');
  if (q && safeEqual(q, TOKEN)) {
    const clean = new URL(url.href);
    clean.searchParams.delete('t');
    res.writeHead(302, {
      Location: clean.pathname + (clean.search || ''),
      'Set-Cookie': cookieHeader(req),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  const html = PAGE(q ? '口令不对，再试一次。' : '');
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function readBody(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function authHandler(req, res, url) {
  if (!accessEnabled) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  let token = url.searchParams.get('t') || '';
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      token = new URLSearchParams(body).get('t') || '';
    } catch {
      token = '';
    }
  }

  if (token && safeEqual(token, TOKEN)) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': cookieHeader(req),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(PAGE('口令不对，再试一次。'));
}

/** 所有响应都带上的反收录头 */
export function applySecurityHeaders(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}
