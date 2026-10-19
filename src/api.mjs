// API 路由
import { home, listCategory, searchAll, suggest, detail, related, like, sourceStats } from './catalog.mjs';
import { publicSources, sourceByKey, config } from './cms.mjs';
import { resolveEpisode, resolveBest, probeM3u8 } from './resolver.mjs';
import { hlsHandler, imageHandler, proxyUrlFor } from './hls.mjs';
import { cache } from './util.mjs';
import zlib from 'node:zlib';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

function json(req, res, obj, status = 200, ttl = 0) {
  const body = Buffer.from(JSON.stringify(obj));
  const ae = String(req?.headers?.['accept-encoding'] || '');
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': ttl ? `public, max-age=${ttl}, stale-while-revalidate=30` : 'no-store',
    Vary: 'Accept-Encoding',
  };
  let out = body;
  if (body.length > 1024 && /\bgzip\b/.test(ae)) {
    out = zlib.gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = out.length;
  res.writeHead(status, headers);
  res.end(out);
}

export async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // 站点配置
    if (p === '/api/config') {
      return json(req, res, {
        site: config.site,
        app: config.app || { version: '' },
        sources: publicSources(),
        cats: [
          { id: 'jp', label: '日番' },
          { id: 'cn', label: '国漫' },
          { id: 'us', label: '欧美' },
          { id: 'ai', label: '漫剧' },
        ],
      }, 200, 300);
    }

    // 首页
    if (p === '/api/home') {
      const data = await home();
      return json(req, res, data, 200, 60);
    }

    // 分类列表
    if (p === '/api/list') {
      const cat = q.get('cat') || 'jp';
      const page = Math.max(1, Number(q.get('page')) || 1);
      const data = await listCategory({ cat, page });
      return json(req, res, data, 200, 60);
    }

    // 搜索
    if (p === '/api/search') {
      const kw = (q.get('q') || '').trim();
      const page = Math.max(1, Number(q.get('page')) || 1);
      const cat = q.get('cat') || '';
      if (!kw) return json(req, res, { q: '', items: [], counts: [] });
      const data = await searchAll(kw, { page, cat });
      return json(req, res, data, 200, 30);
    }

    // 搜索联想（本地匹配，海量数据零延迟）
    if (p === '/api/suggest') {
      const kw = (q.get('q') || '').trim();
      if (!kw) return json(req, res, { q: '', items: [] }, 200, 30);
      return json(req, res, { q: kw, items: await suggest(kw) }, 200, 30);
    }

    // 热词：取首页标题做推荐
    if (p === '/api/hotwords') {
      const d = await home();
      const words = [...new Set((d.hero || []).map((x) => x.name).filter(Boolean))].slice(0, 8);
      return json(req, res, { words }, 200, 300);
    }

    // 详情
    if (p === '/api/detail') {
      const key = q.get('key');
      const id = q.get('id');
      if (!key || !id) return json(req, res, { error: 'key/id required' }, 400);
      const d = await detail(key, id);
      if (!d) return json(req, res, { error: 'not found' }, 404);
      return json(req, res, d);
    }

    // 跨源同番
    if (p === '/api/related') {
      const name = q.get('name') || '';
      const key = q.get('key') || '';
      const id = q.get('id') || '';
      if (!name) return json(req, res, { items: [] });
      const items = await related(name, key, id);
      return json(req, res, items, 200, 120);
    }

    // 详情页猜你喜欢
    if (p === '/api/like') {
      const name = q.get('name') || '';
      const cat = q.get('cat') || '';
      const items = await like(name, cat);
      return json(req, res, items, 200, 120);
    }

    // 取流：解析成可播放 m3u8
    if (p === '/api/stream') {
      const key = q.get('key');
      const id = q.get('id');
      const line = Math.max(0, Number(q.get('line')) || 0);
      const ep = Math.max(0, Number(q.get('ep')) || 0);
      const src = sourceByKey(key);
      if (!src) return json(req, res, { ok: false, reason: 'unknown source' }, 400);
      const ck = `stream:${key}:${id}:${line}:${ep}`;
      const cached = cache.get(ck);
      if (cached) return json(req, res, cached);

      const d = await detail(key, id);
      if (!d || !d.lines?.length) return json(req, res, { ok: false, reason: 'no playable lines' }, 404);

      let r;
      if (line < d.lines.length && d.lines[line].episodes[ep]) {
        const l = d.lines[line];
        const e = l.episodes[ep];
        r = await resolveEpisode(e.url, src.api);
        r.lineIndex = line;
        r.lineName = l.from;
        r.episode = e.name;
      }
      if (!r?.ok) {
        const best = await resolveBest(d.lines, src.api, line, ep);
        if (best.ok) r = best;
      }
      if (!r?.ok) {
        return json(req, res, { ok: false, reason: r?.reason || 'unavailable' }, 502);
      }

      const payload = {
        ok: true,
        source: { key: src.key, name: src.name },
        lineIndex: r.lineIndex,
        lineName: r.lineName,
        episode: r.episode,
        raw: r.m3u8,
        url: proxyUrlFor(r.m3u8, r.referer),
        lines: d.lines.map((l) => ({ from: l.from, count: l.episodes.length })),
      };
      cache.set(ck, payload, 120_000);
      return json(req, res, payload);
    }

    // 探测某个 m3u8 可用性（前端换线前用）
    if (p === '/api/probe') {
      const u = q.get('u') || '';
      const r = await probeM3u8(u, q.get('r') || '');
      return json(req, res, { ok: r.ok, status: r.status });
    }

    // HLS 代理
    if (p === '/api/hls') {
      const u = decodeParam(q.get('u'));
      const r = decodeParam(q.get('r'));
      return await hlsHandler(req, res, u, r);
    }

    // 图片代理
    if (p === '/api/img') {
      const u = decodeParam(q.get('u'));
      return await imageHandler(req, res, u, q.get('r') || '');
    }

    // 源健康状态
    if (p === '/api/health') {
      const stats = await sourceStats();
      return json(req, res, { stats, at: new Date().toISOString() });
    }

    return json(req, res, { error: 'unknown api' }, 404);
  } catch (e) {
    console.error('[api]', p, e);
    return json(req, res, { error: String(e.message || e) }, 500);
  }
}

function decodeParam(v) {
  if (!v) return '';
  // 支持 base64url 与明文 URL
  if (/^https?:\/\//i.test(v)) return v;
  try {
    const d = Buffer.from(v, 'base64url').toString('utf8');
    if (/^https?:\/\//i.test(d)) return d;
  } catch {}
  return v;
}
