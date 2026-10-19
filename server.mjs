// ANIHUB 服务：静态站点（内存 + 预压缩）+ 聚合 API + HLS 代理
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { handleApi } from './src/api.mjs';
import { proxyHandler } from './src/proxy.mjs';
import { accessEnabled, allowed, gate, authHandler, applySecurityHeaders, plantCookie } from './src/access.mjs';
import { home, listCategory, searchAll } from './src/catalog.mjs';
import { warmImage } from './src/hls.mjs';
import { config } from './src/cms.mjs';
import { cache } from './src/util.mjs';

/** 落盘缓存的年龄，用来判断这份数据新不新 */
function cachedAge() {
  try {
    const raw = fs.readFileSync(cache.file, 'utf8');
    const t = JSON.parse(raw).savedAt || 0;
    const mins = Math.round((Date.now() - t) / 60000);
    return mins < 1 ? '刚刚' : `${mins} 分钟前`;
  } catch {
    return '未知';
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.txt': 'text/plain; charset=utf-8',
};

const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg']);
const assets = new Map();

function warmStatic() {
  const started = Date.now();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const rel = '/' + path.relative(PUBLIC, full).split(path.sep).join('/');
      const ext = path.extname(full).toLowerCase();
      const raw = fs.readFileSync(full);
      const item = {
        raw,
        ext,
        type: MIME[ext] || 'application/octet-stream',
        etag: `W/"${raw.length.toString(16)}-${st.mtimeMs.toString(36)}"`,
      };
      if (TEXT_EXT.has(ext) && raw.length > 700) {
        item.gz = zlib.gzipSync(raw, { level: 6 });
        try {
          item.br = zlib.brotliCompressSync(raw, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
          });
        } catch {}
      }
      assets.set(rel, item);
    }
  };
  walk(PUBLIC);
  const total = [...assets.values()].reduce((n, a) => n + a.raw.length, 0);

  // 前端没走打包器，用内容指纹当查询参数，改了文件 URL 就变，老缓存自动失效
  const stamp = (rel) => {
    const a = assets.get(rel);
    return a ? createHash('sha1').update(a.raw).digest('hex').slice(0, 8) : '0';
  };
  const hlsV = stamp('/vendor/hls.min.js');

  // app.js 里用 __HLSV__ 记着 hls.js 的地址（按需加载），先把指纹填进去
  const app = assets.get('/app.js');
  if (app) {
    let src = app.raw.toString('utf8');
    const before = src;
    src = src.split('__HLSV__').join(hlsV);

    // 本地 ESM 依赖也逐个带指纹：from './player.js' → from './player.js?v=<sha1前8位>
    // 没有指纹时浏览器会拿 no-cache 里缓存的旧模块，改完前端就等于没改
    src = src.replace(/(from\s+['"])(\.\/[\w.-]+\.js)(['"])/g, (m, head, rel, tail) => {
      return head + rel + '?v=' + stamp('/' + rel.replace(/^\.\//, '')) + tail;
    });

    if (src !== before) {
      app.raw = Buffer.from(src, 'utf8');
      app.etag = `W/"${app.raw.length.toString(16)}-${createHash('sha1').update(app.raw).digest('hex').slice(0, 8)}"`;
      app.gz = zlib.gzipSync(app.raw, { level: 6 });
      try {
        app.br = zlib.brotliCompressSync(app.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
      } catch {}
    }
  }

  const V = {
    __JSV__: stamp('/app.js'),
    __CSSV__: stamp('/styles.css'),
    __HLSV__: hlsV,
    __FAVV__: stamp('/favicon.ico'),
    __ICOV__: stamp('/apple-touch-icon.png'),
  };
  const idx = assets.get('/index.html');
  if (idx) {
    let html = idx.raw.toString('utf8');
    for (const [k, v] of Object.entries(V)) html = html.split(k).join(v);
    idx.raw = Buffer.from(html, 'utf8');
    idx.etag = `W/"${idx.raw.length.toString(16)}-${V.__JSV__}${V.__CSSV__}"`;
    if (idx.raw.length > 700) {
      idx.gz = zlib.gzipSync(idx.raw, { level: 6 });
      try {
        idx.br = zlib.brotliCompressSync(idx.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
      } catch {}
    }
  }

  console.log(`  static warm: ${assets.size} files, ${(total / 1024).toFixed(0)}KB raw, ${Date.now() - started}ms (js ${V.__JSV__} / css ${V.__CSSV__})`);
}
warmStatic();

function pickEncoding(req, item) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (item.br && /\bbr\b/.test(ae)) return 'br';
  if (item.gz && /\bgzip\b/.test(ae)) return 'gz';
  return null;
}

function serveStatic(req, res, pathname, search = '') {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  let item = assets.get(rel);
  if (!item && !path.extname(rel)) item = assets.get('/index.html');
  if (!item) item = assets.get('/index.html');
  if (!item) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }

  const isHtml = item.ext === '.html';
  // 带 ?v=<内容指纹> 的 js/css 可以放心长缓存，改文件指纹就变，URL 跟着变
  const versioned = /[?&]v=[0-9a-f]{6,}/.test(search);
  const longCache = versioned && ['.js', '.css', '.mjs', '.ico', '.png'].includes(item.ext);
  const headers = {
    'Content-Type': item.type,
    'Cache-Control': longCache ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: item.etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === item.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const enc = pickEncoding(req, item);
  const body = enc ? item[enc] : item.raw;
  if (enc) headers['Content-Encoding'] = enc === 'br' ? 'br' : 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

const handler = async (req, res) => {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }

  // 反收录 + 防点击劫持，所有响应统一带
  applySecurityHeaders(res);

  res.on('finish', () => {
    if (url.pathname.startsWith('/api/')) {
      const ms = Date.now() - t0;
      if (ms > 1500 || res.statusCode >= 400) {
        console.log(`[${req.method}] ${url.pathname}${url.search.slice(0, 90)} -> ${res.statusCode} ${ms}ms`);
      }
    }
  });

  if (url.pathname === '/__auth') return authHandler(req, res, url);
  // 健康检查给云平台探活用，不带口令也放行，但只回一个 ok，不泄露源信息
  if (url.pathname === '/api/health' && !allowed(req, url)) {
    return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end('{"ok":true}');
  }
  if (!allowed(req, url)) return gate(req, res, url);
  // 口令链接（?t=...）进来的第一跳：种 Cookie，页面照常返回，由前端擦掉地址栏里的 t
  if (accessEnabled && url.searchParams.get('t')) plantCookie(req, res);

  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (url.pathname === '/p') return proxyHandler(req, res, url);
  return serveStatic(req, res, url.pathname, url.search);
};

// 端口：命令行 --port 优先，其次环境变量，其次 sources.json
const ARG_PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i > -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  const kv = process.argv.find((a) => a.startsWith('--port='));
  return kv ? Number(kv.split('=')[1]) : 0;
})();
const EXPLICIT_PORT = Boolean(ARG_PORT || process.env.PORT);
const PORT = Number(ARG_PORT || process.env.PORT || config.site?.port || 7788);

// 退出前把缓存写盘，下次启动直接读
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    const n = cache.flush();
    try { fs.unlinkSync(path.join(__dirname, 'data', 'running.json')); } catch {}
    console.log(`\n  缓存落盘 ${n} 条，退出。`);
    process.exit(0);
  });
}

/** 占用某端口的进程 PID（Windows 走 netstat，其它走 lsof） */
function pidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p TCP | findstr ":${port}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        if (/LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          return parts[parts.length - 1];
        }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim().split('\n')[0];
    }
  } catch {}
  return '';
}

function sayPortBusy(port) {
  const pid = pidOnPort(port);
  console.log('');
  console.log(`  ✗ 端口 ${port} 已经被占用了。`);
  if (pid) {
    console.log(`    占用进程 PID ${pid}`);
    console.log(`    结束它：  taskkill /PID ${pid} /F`);
    console.log(`    或换端口：node server.mjs --port ${port + 1}`);
  } else {
    console.log(`    换端口：  node server.mjs --port ${port + 1}`);
  }
  console.log('');
}

/** 起服务；端口被占时自动顺延（除非用户显式指定了端口） */
function start(port, attempt = 0) {
  const server = http.createServer(handler);

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const autoPick = !EXPLICIT_PORT && attempt < 9;
      if (autoPick) {
        console.log(`  端口 ${port} 被占用，改试 ${port + 1}…`);
        setTimeout(() => start(port + 1, attempt + 1), 60);
        return;
      }
      sayPortBusy(port);
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.log(`\n  ✗ 没有权限绑定端口 ${port}，换一个 1024 以上的端口试试。\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, () => onListening(server, port));
}

async function onListening(server, port) {
  const addr = `http://127.0.0.1:${port}`;
  console.log(`\n  ANIHUB · ${config.site?.tagline || ''}`);
  console.log(`  ${addr}\n`);
  console.log(`  聚合源 ${config.sources.length} 个：${config.sources.map((s) => s.name).join(' / ')}`);
  console.log('  Ctrl+C 停止，关窗口也一样\n');
  if (port !== PORT) {
    console.log(`  提示：${PORT} 被占用，这次跑在 ${port}，浏览器请开 ${addr}\n`);
  }
  try {
    fs.writeFileSync(path.join(__dirname, 'data', 'running.json'), JSON.stringify({ port, pid: process.pid, at: Date.now() }), 'utf8');
  } catch {}

  if (process.env.ANIHUB_OPEN === '1') openBrowser(addr);

  // 先读落盘缓存：命中就不用再抓一遍
  const restored = await cache.load();
  if (restored) console.log(`  cache restored: ${restored} 条（${cachedAge()}）`);

  warmup().catch((e) => console.log('  warmup failed:', e.message));
}

/**
 * 用默认浏览器打开地址。
 * Windows 上 `cmd /c start "" url` 经 spawn 传空参数并不可靠（空字符串会被吞掉，
 * start 就把 URL 当成窗口标题，于是什么都不开），所以改成 ShellExecute 上来：
 * 先走 PowerShell 的 Start-Process，再退到 rundll32，最后才试 cmd start。
 */
function openBrowser(url) {
  const warn = () => console.log(`  浏览器没自动打开，手动访问 ${url}\n`);

  if (process.platform !== 'win32') {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      warn();
    }
    return;
  }

  const steps = [
    ['powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`]],
    ['rundll32', ['url.dll,FileProtocolHandler', url]],
    ['cmd', ['/c', 'start', '""', url]],
  ];

  const attempt = (i) => {
    if (i >= steps.length) return warn();
    const [cmd, args] = steps[i];
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      return attempt(i + 1);
    }
    child.on('error', () => attempt(i + 1));
    child.on('exit', (code) => {
      if (code) attempt(i + 1);
    });
    child.unref();
    return undefined;
  };

  attempt(0);
}

/** 启动预热：首页 → 首屏海报 → 分类页与热门搜索 */
async function warmup() {
  const t0 = Date.now();
  const d = await home();
  const sections = d.sections || [];
  console.log(`  warm home: ${sections.reduce((m, s) => m + s.items.length, 0)} 张卡片 / ${d.stats?.sources || 0} 源 / ${Date.now() - t0}ms`);

  // 海报代理冷，预取首屏能省掉一屏的等待
  const pics = [...(d.hero || []), ...sections.flatMap((s) => s.items.slice(0, 14))]
    .map((it) => it.pic)
    .filter(Boolean)
    .map((p) => {
      const m = /[?&]u=([^&]+)/.exec(p);
      return m ? decodeURIComponent(m[1]) : '';
    })
    .filter(Boolean);
  const uniq = [...new Set(pics)].slice(0, 24);
  const posters = Promise.all(uniq.map((u) => warmImage(u).then(() => 1).catch(() => 0))).then((r) =>
    console.log(`  warm posters: ${r.reduce((a, b) => a + b, 0)}/${uniq.length} in ${Date.now() - t0}ms`),
  );

  await posters;

  // 分类页与热门搜索放到后面慢慢跑：首屏不需要它们，抢带宽反而拖慢海报
  const cats = ['jp', 'cn', 'us', 'ai'];
  const words = [...new Set([...(d.hero || []).map((x) => x.name), ...sections.flatMap((s) => s.items.slice(0, 2).map((x) => x.name))])].slice(0, 5);
  const idle = setTimeout(async () => {
    const t1 = Date.now();
    for (const c of cats) {
      await Promise.all([
        listCategory({ cat: c, page: 1 }).catch(() => {}),
        listCategory({ cat: c, page: 2 }).catch(() => {}),
      ]);
    }
    for (const w of words) await searchAll(w, {}).catch(() => {});
    console.log(`  warm lists: ${cats.length} 分类 + ${words.length} 关键词 / ${Date.now() - t1}ms`);
  }, 12_000);
  idle.unref?.();
}

start(PORT);
