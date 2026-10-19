// ─────────────────────────────────────────────────────────────
// ANIHUB mobile core — 浏览器端的聚合层
// 桌面版这些逻辑跑在 Node 里；APK 里没有 Node，所以搬进浏览器。
// 所有对外请求都走 /p?u=<base64url>（由容器转发，绕开跨域与防盗链）。
// ─────────────────────────────────────────────────────────────

const UA_HEADERS = { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

// ---------- 编解码 ----------
export const b64u = {
  encode(s) {
    const bytes = new TextEncoder().encode(String(s));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s) {
    try {
      const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  },
};

export function proxyUrl(url) {
  return '/p?u=' + b64u.encode(url);
}

// ---------- 缓存（纯内存，APK 进程被杀就没了，够用） ----------
class Cache {
  constructor(max = 300) {
    this.max = max;
    this.map = new Map();
    this.inflight = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.val;
  }
  set(key, val, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  }
  async wrap(key, ttlMs, fn, { swr = 0 } = {}) {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.exp > now) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.val;
    }
    if (hit && swr > 0 && hit.exp + swr > now) {
      if (!hit.busy) {
        hit.busy = true;
        Promise.resolve()
          .then(fn)
          .then((v) => {
            hit.busy = false;
            if (v != null) this.set(key, v, ttlMs);
          })
          .catch(() => {
            hit.busy = false;
          });
      }
      return hit.val;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const val = await fn();
        if (val != null) this.set(key, val, ttlMs);
        return val;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }
  clear() {
    this.map.clear();
    this.inflight.clear();
  }
}

export const cache = new Cache(300);

// ---------- 网络 ----------
export async function fetchT(url, { timeout = 12000, headers = {}, text = false } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(proxyUrl(url), {
      signal: ac.signal,
      headers: { ...UA_HEADERS, ...headers },
    });
    return text ? r : r;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, opts = {}) {
  const r = await fetchT(url, opts);
  return r.ok ? r.text() : '';
}

export async function fetchJson(url, opts = {}) {
  try {
    const r = await fetchT(url, { ...opts, headers: { Accept: 'application/json,*/*', ...(opts.headers || {}) } });
    if (!r.ok) return null;
    const txt = await r.text();
    const s = txt.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 文本 ----------
export function normName(s) {
  const CN = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/(动画版|动漫版|国漫版|普通话版|国语版|日语版|中配版|高清版|完整版)/g, '')
    .replace(/第([一二三四五六七八九十0-9]+)[季部期]/g, (_m, n) => CN[n] || n)
    .replace(/[·・:：!！?？,，.。'"“”‘’()（）\[\]【】\-—_~～/\\|]/g, '')
    .replace(/(season|s)(\d+)/g, '$2')
    .replace(/(动漫|动画|番剧|全集)$/g, '');
}

export function simName(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.62 + 0.3 * ratio;
  }
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(x);
  const B = grams(y);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t\u00a0\u3000]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function absUrl(u, base) {
  if (!u) return '';
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

// ---------- 采集源配置 ----------
let CONFIG = null;

export async function loadConfig() {
  if (CONFIG) return CONFIG;
  const r = await fetch('sources.json', { cache: 'force-cache' });
  const raw = await r.json();
  raw.sources = (raw.sources || []).filter((s) => s.enabled !== false);
  CONFIG = raw;
  return raw;
}

export async function sources() {
  return (await loadConfig()).sources;
}

export async function sourceByKey(key) {
  return (await sources()).find((s) => s.key === key) || null;
}

// ---------- macCMS 客户端 ----------
async function cms(src, params = {}, ttl = 60_000) {
  const url = new URL(src.api);
  for (const [k, v] of Object.entries({ ac: 'detail', pg: 1, ...params })) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const key = 'cms:' + url.href;
  return cache.wrap(key, ttl, async () => {
    const json = await fetchJson(url.href, { timeout: 15000 });
    if (!json || Number(json.code) !== 1) return null;
    return json;
  });
}

export async function cmsList(src, { cat = 'jp', page = 1, wd = '', t } = {}) {
  const typeIds = t ? [t] : src.types?.[cat] || [];
  if (typeIds.length === 0) return { list: [], total: 0, page, pagecount: 0 };
  const results = await mapLimit(typeIds, 3, (tid) => cms(src, { ac: 'detail', t: tid, pg: page, wd }, 90_000));
  const merged = [];
  let total = 0;
  let pagecount = 0;
  for (const r of results) {
    if (!r) continue;
    total += Number(r.total) || 0;
    pagecount = Math.max(pagecount, Number(r.pagecount) || 0);
    for (const v of r.list || []) merged.push(v);
  }
  return { list: merged, total, page, pagecount };
}

export async function cmsSearch(src, wd, page = 1) {
  return cms(src, { ac: 'detail', wd, pg: page }, 120_000);
}

export async function cmsDetail(src, id) {
  const r = await cms(src, { ac: 'detail', ids: id }, 300_000);
  return r?.list?.[0] || null;
}

// ---------- 归一化 ----------
const CAT_LABEL = { jp: '日番', cn: '国漫', us: '欧美', ai: 'AI漫剧' };

function pic(src, v) {
  const raw = v.vod_pic || v.vod_pic_slide || '';
  if (!raw) return '';
  return proxyUrl(absUrl(raw, src.api));
}

function playUrls(v) {
  const froms = String(v.vod_play_from || '').split('$$$');
  const groups = String(v.vod_play_url || '').split('$$$');
  const lines = [];
  groups.forEach((g, i) => {
    if (!g) return;
    const episodes = [];
    for (const piece of g.split('#')) {
      if (!piece) continue;
      const at = piece.indexOf('$');
      const rawName = at >= 0 ? piece.slice(0, at) : '';
      const url = at >= 0 ? piece.slice(at + 1) : piece;
      if (!url) continue;
      episodes.push({ name: (rawName || `第${episodes.length + 1}集`).trim(), url });
    }
    if (episodes.length === 0) return;
    lines.push({
      from: froms[i] || `线路${i + 1}`,
      direct: /\.m3u8(\?|$)/i.test(episodes[0].url),
      episodes,
    });
  });
  return lines;
}

function lite(it) {
  return {
    key: it.key,
    source: it.source,
    id: it.id,
    name: it.name,
    sub: it.sub,
    pic: it.pic,
    remarks: it.remarks,
    year: it.year,
    area: it.area,
    typeName: it.typeName,
    cat: it.cat,
    catLabel: it.catLabel,
    score: it.score,
    weight: it.weight,
    alt: it.alt,
  };
}

export function normalize(src, v) {
  if (!v) return null;
  const typeName = v.type_name || '';
  let cat = 'other';
  if (/日韩动漫|日本动漫|日番/.test(typeName)) cat = 'jp';
  else if (/国产动漫|国漫|国创/.test(typeName)) cat = 'cn';
  else if (/欧美动漫|美国动漫|欧美动画/.test(typeName)) cat = 'us';
  else if (/AI漫剧|动态漫/.test(typeName)) cat = 'ai';
  else if (/动画|动漫|番剧/.test(typeName)) cat = 'jp';

  const rawText = stripTags(v.vod_content || v.vod_blurb || '');
  const content = /^[\s\-—–·.]*$/.test(rawText) ? '' : rawText;

  return {
    key: src.key,
    source: src.name,
    id: String(v.vod_id),
    name: v.vod_name || '',
    sub: v.vod_sub || '',
    en: v.vod_en || '',
    pic: pic(src, v),
    remarks: v.vod_remarks || '',
    year: v.vod_year || '',
    area: v.vod_area || '',
    lang: v.vod_lang || '',
    typeName,
    class: v.vod_class || '',
    cat,
    catLabel: CAT_LABEL[cat] || typeName,
    score: Number(v.vod_score) || 0,
    hits: Number(v.vod_hits) || 0,
    updatedAt: v.vod_time || '',
    total: Number(v.vod_total) || 0,
    content,
    actor: v.vod_actor || '',
    director: v.vod_director || '',
  };
}

export function normalizeDetail(src, v) {
  const base = normalize(src, v);
  if (!base) return null;
  base.lines = playUrls(v);
  base.episodeCount = base.lines.reduce((m, l) => Math.max(m, l.episodes.length), 0);
  return base;
}

function mergeItems(groups) {
  const map = new Map();
  for (const g of groups) {
    for (const it of g.items || []) {
      const k = normName(it.name);
      const cur = map.get(k);
      if (!cur) {
        map.set(k, { ...it, alt: [] });
      } else {
        cur.alt.push({ key: it.key, id: it.id, source: it.source });
        if ((it.weight || 0) > (cur.weight || 0)) {
          const alt = cur.alt;
          Object.assign(cur, { ...it, alt });
        }
      }
    }
  }
  return [...map.values()];
}

// ---------- 首页 ----------
export async function home() {
  return cache.wrap(
    'home:v4',
    180_000,
    async () => {
      const all = await sources();
      const plan = [
        { cat: 'jp', page: 1 },
        { cat: 'cn', page: 1 },
        { cat: 'us', page: 1 },
        { cat: 'ai', page: 1 },
      ];
      const tasks = [];
      for (const p of plan) {
        for (const s of all) {
          if (!s.types || !s.types[p.cat]?.length) continue;
          tasks.push({ ...p, src: s });
        }
      }
      const results = await mapLimit(tasks, 6, async (t) => {
        const r = await cmsList(t.src, { cat: t.cat, page: t.page });
        const items = (r.list || []).map((v) => {
          const n = normalize(t.src, v);
          if (n) n.weight = t.src.weight;
          return n;
        });
        return { ...t, items: items.filter(Boolean), total: r?.total || 0 };
      });

      const byCat = { jp: [], cn: [], us: [], ai: [] };
      let catalogSize = 0;
      for (const r of results) {
        if (!r) continue;
        catalogSize += r.total || 0;
        for (const it of r.items) if (it.cat && byCat[it.cat]) byCat[it.cat].push(it);
      }
      const clean = (arr) =>
        mergeItems([{ items: arr }])
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 42);

      const jp = clean(byCat.jp);
      const cn = clean(byCat.cn);
      const us = clean(byCat.us);
      const ai = clean(byCat.ai);

      const hotScore = (it) => {
        const alts = (it.alt || []).length;
        const t = Date.parse((it.updatedAt || '').replace(' ', 'T') + '+08:00') || 0;
        const days = t ? Math.max(0, (Date.now() - t) / 86400000) : 999;
        const fresh = Math.max(0, 4 - Math.min(days, 4));
        return alts * 1.6 + fresh * 1.2 + (it.score || 0) * 0.1;
      };
      const hero = [];
      for (const it of [...jp, ...cn].sort((a, b) => hotScore(b) - hotScore(a))) {
        if (hero.some((p) => simName(p.name, it.name) > 0.72)) continue;
        hero.push(it);
        if (hero.length >= 5) break;
      }

      return {
        updatedAt: new Date().toISOString(),
        hero: hero.map((it) => ({ ...lite(it), content: String(it.content || '').slice(0, 180) })),
        sections: [
          { id: 'jp', title: '新番速递', sub: '本季日番 · 实时更新', items: jp },
          { id: 'cn', title: '国漫精选', sub: '国创与动态漫', items: cn },
          { id: 'us', title: '欧美动画', sub: 'Western Animation', items: us },
          { id: 'ai', title: '漫剧专场', sub: '动态漫 · 竖屏短番', items: ai },
        ]
          .filter((sec) => sec.items.length > 0)
          .map((sec) => ({ ...sec, items: sec.items.slice(0, 24).map(lite) })),
        stats: {
          sources: all.length,
          catalog: catalogSize,
          fetched: results.reduce((n, r) => n + (r?.items?.length || 0), 0),
        },
      };
    },
    { swr: 600_000 },
  );
}

export async function listCategory({ cat = 'jp', page = 1 } = {}) {
  const all = await sources();
  return cache.wrap(
    `list:${cat}:${page}`,
    180_000,
    async () => {
      const results = await mapLimit(all, 7, async (s) => {
        const r = await cmsList(s, { cat, page });
        const items = (r.list || [])
          .map((v) => {
            const n = normalize(s, v);
            if (n) n.weight = s.weight;
            return n;
          })
          .filter(Boolean);
        return { items };
      });
      const items = mergeItems(results).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return {
        cat,
        page,
        items: items.map(lite),
        total: results.reduce((n, r) => n + (r?.items?.length || 0), 0),
      };
    },
    { swr: 600_000 },
  );
}

export async function searchAll(q, { page = 1, cat = '' } = {}) {
  const kw = String(q || '').trim();
  if (!kw) return { q: kw, items: [], counts: [] };
  const all = await sources();
  const data = await cache.wrap(
    `search:${kw.toLowerCase()}:${page}`,
    150_000,
    async () => {
      const results = await mapLimit(all, 7, async (s) => {
        const r = await cmsSearch(s, kw, page);
        const list = r?.list || [];
        const items = list
          .filter((v) => v.type_name && /动漫|动画|番剧|漫剧|动态漫/.test(v.type_name))
          .map((v) => {
            const n = normalize(s, v);
            if (n) n.weight = s.weight;
            return n;
          })
          .filter(Boolean)
          .map((n) => ({ ...n, score: simName(kw, n.name) }));
        return { items };
      });
      const flat = results.flatMap((r) => r?.items || []);
      flat.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const items = mergeItems([{ items: flat }]).map(lite);
      return {
        q: kw,
        items,
        counts: all.map((s, i) => ({ key: s.key, name: s.name, n: results[i]?.items.length || 0 })),
      };
    },
    { swr: 600_000 },
  );
  if (!cat) return data;
  return { ...data, items: data.items.filter((it) => it.cat === cat), cat };
}

export async function suggest(q) {
  const kw = String(q || '').trim();
  if (!kw) return [];
  const nk = normName(kw);
  const shape = (it, s) => ({
    name: it.name,
    key: it.key,
    id: it.id,
    cat: it.cat,
    catLabel: it.catLabel,
    year: it.year,
    s,
    pic: it.pic,
  });

  let pool = [];
  try {
    const data = await home();
    pool = [...(data.hero || []), ...(data.sections || []).flatMap((s) => s.items)];
  } catch {}

  const seen = new Set();
  const local = [];
  for (const it of pool) {
    const nn = normName(it.name);
    if (!nn || seen.has(nn)) continue;
    let s = 0;
    if (nn.startsWith(nk)) s = 1;
    else if (nn.includes(nk)) s = 0.85;
    else s = simName(kw, it.name);
    if (s < 0.5) continue;
    seen.add(nn);
    local.push(shape(it, s));
  }
  local.sort((a, b) => b.s - a.s);
  if (local.length >= 4) return local.slice(0, 7);

  const all = await sources();
  const remote = await cache.wrap(
    `sug:${nk}`,
    300_000,
    async () => {
      const picks = [...all].sort((a, b) => b.weight - a.weight).slice(0, 3);
      const groups = await mapLimit(picks, 3, async (s) => {
        const r = await cmsSearch(s, kw, 1);
        return (r?.list || [])
          .map((v) => normalize(s, v))
          .filter(Boolean)
          .map((it) => ({ ...it, weight: s.weight }));
      });
      const merged = mergeItems(groups.map((items) => ({ items })));
      return merged
        .filter((it) => /动漫|动画|番剧|漫剧|动态漫/.test(it.typeName || ''))
        .map((it) => {
          const nn = normName(it.name);
          const s = nn.startsWith(nk) ? 1 : nn.includes(nk) ? 0.85 : simName(kw, it.name);
          return { it, s };
        })
        .filter((x) => x.s > 0.32)
        .sort((a, b) => b.s - a.s)
        .slice(0, 7)
        .map((x) => shape(x.it, x.s));
    },
    { swr: 900_000 },
  );

  const out = [...local];
  for (const it of remote || []) {
    if (seen.has(normName(it.name))) continue;
    seen.add(normName(it.name));
    out.push(it);
    if (out.length >= 7) break;
  }
  return out.slice(0, 7);
}

export async function detail(key, id) {
  const src = await sourceByKey(key);
  if (!src) return null;
  return cache.wrap(`detail:${key}:${id}`, 240_000, async () => {
    const v = await cmsDetail(src, id);
    return normalizeDetail(src, v);
  });
}

export async function related(name, excludeKey, excludeId) {
  const all = await sources();
  return cache.wrap(`rel:${normName(name)}:${excludeKey}:${excludeId}`, 420_000, async () => {
    const results = await mapLimit(all, 5, async (s) => {
      const r = await cmsSearch(s, name, 1);
      const list = r?.list || [];
      const best = list
        .map((v) => ({ v, sco: simName(name, v.vod_name || '') }))
        .filter((x) => x.sco >= 0.72 && x.v.vod_type_name !== '电影解说')
        .sort((a, b) => b.sco - a.sco)[0];
      if (!best) return null;
      const d = await cmsDetail(s, best.v.vod_id);
      return d ? normalizeDetail(s, d) : null;
    });
    return results
      .filter(Boolean)
      .filter((d) => !(d.key === excludeKey && String(d.id) === String(excludeId)))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));
  });
}

export async function like(name, cat) {
  const nk = normName(name || '');
  return cache.wrap(`like:${cat || 'jp'}:${nk}`, 300_000, async () => {
    const homeData = await home();
    const secs = homeData.sections || [];
    const pool = [...secs.filter((s) => !cat || s.id === cat), ...secs.filter((s) => cat && s.id !== cat)].flatMap(
      (s) => s.items || [],
    );
    const seen = new Set([nk]);
    const out = [];
    for (const it of pool) {
      const k = normName(it.name);
      if (seen.has(k)) continue;
      if (nk && simName(nk, k) > 0.7) continue;
      seen.add(k);
      out.push(it);
      if (out.length >= 12) break;
    }
    return out;
  });
}

// ---------- 播放地址解析 ----------
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const M3U8_RE = /["'(]([^"'()\s\\]+\.m3u8[^"'()\s\\]*)["')]/g;

export function extractCandidates(html, pageUrl) {
  const out = [];
  const push = (u) => {
    if (!u) return;
    const s = String(u).trim();
    if (!s || s.startsWith('data:')) return;
    out.push(absUrl(s, pageUrl));
  };
  for (const m of html.matchAll(/var\s+(?:main|url|video|videourl|m3u8)\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  const pa = html.match(/player_aaaa\s*=\s*(\{[\s\S]{0,4000}?\})\s*[;<]/);
  if (pa) {
    try {
      const o = JSON.parse(pa[1]);
      if (o.url) push(o.url);
    } catch {
      const u = pa[1].match(/"url"\s*:\s*"([^"]+)"/);
      if (u) push(u[1]);
    }
  }
  for (const m of html.matchAll(/"(?:url|src|file|playurl|m3u8)"\s*:\s*"([^"]+\.m3u8[^"]*)"/g)) push(m[1]);
  for (const m of html.matchAll(M3U8_RE)) push(m[1]);
  return [...new Set(out)];
}

export async function probeM3u8(url, referer = '', timeout = 7000) {
  try {
    const r = await fetch(proxyUrl(url) + (referer ? '&r=' + b64u.encode(referer) : ''), {
      signal: (() => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), timeout);
        return ac.signal;
      })(),
      headers: { Range: 'bytes=0-2048' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const text = (await r.text()).slice(0, 2048);
    return { ok: text.includes('#EXTM3U'), status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

export async function resolveEpisode(episodeUrl, sourceApi) {
  const baseReferer = originOf(sourceApi) + '/';
  if (!episodeUrl) return { ok: false, reason: 'empty' };
  if (/\.m3u8(\?|$)/i.test(episodeUrl)) {
    const p = await probeM3u8(episodeUrl, baseReferer);
    if (p.ok) return { ok: true, m3u8: episodeUrl, referer: baseReferer, direct: true };
    return { ok: false, reason: `m3u8 不可达 (${p.status})`, m3u8: episodeUrl };
  }

  const key = 'resolve:' + episodeUrl;
  const cached = cache.get(key);
  if (cached) return cached;

  let html = '';
  try {
    html = await fetchText(episodeUrl, { timeout: 12000, headers: { Referer: baseReferer } });
    if (!html) return { ok: false, reason: '播放页抓取失败' };
  } catch (e) {
    return { ok: false, reason: '播放页抓取失败: ' + String(e.message || e) };
  }

  const cands = extractCandidates(html, episodeUrl).slice(0, 6);
  for (const u of cands) {
    const p = await probeM3u8(u, baseReferer, 6000);
    if (p.ok) {
      const res = { ok: true, m3u8: u, referer: baseReferer, direct: false };
      cache.set(key, res, 600_000);
      return res;
    }
  }
  return { ok: false, reason: '未找到可用 m3u8' };
}

export async function resolveBest(lines, sourceApi, startLine = 0, epIndex = 0) {
  const order = [];
  for (let i = 0; i < lines.length; i++) order.push((startLine + i) % lines.length);
  for (const li of order) {
    const line = lines[li];
    const ep = line.episodes[epIndex] || line.episodes[0];
    if (!ep) continue;
    const r = await resolveEpisode(ep.url, sourceApi);
    if (r.ok) return { ...r, lineIndex: li, lineName: line.from, episode: ep.name };
  }
  return { ok: false, reason: 'all-lines-failed' };
}

// ---------- 对外：/api/* 的本地实现 ----------
const CATS = [
  { id: 'jp', label: '日番' },
  { id: 'cn', label: '国漫' },
  { id: 'us', label: '欧美' },
  { id: 'ai', label: '漫剧' },
];

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function handleApi(href) {
  const url = new URL(href, location.href);
  const p = url.pathname;
  const q = url.searchParams;

  try {
    if (p === '/api/config') {
      const cfg = await loadConfig();
      return jsonResponse({
        site: cfg.site,
        app: cfg.app || { version: '' },
        sources: (await sources()).map((s) => ({
          key: s.key,
          name: s.name,
          weight: s.weight,
          types: s.types,
          note: s.note || '',
        })),
        cats: CATS,
      });
    }

    if (p === '/api/home') return jsonResponse(await home());

    if (p === '/api/list') {
      const cat = q.get('cat') || 'jp';
      const page = Math.max(1, Number(q.get('page')) || 1);
      return jsonResponse(await listCategory({ cat, page }));
    }

    if (p === '/api/search') {
      const kw = (q.get('q') || '').trim();
      const page = Math.max(1, Number(q.get('page')) || 1);
      const cat = q.get('cat') || '';
      if (!kw) return jsonResponse({ q: '', items: [], counts: [] });
      return jsonResponse(await searchAll(kw, { page, cat }));
    }

    if (p === '/api/suggest') {
      const kw = (q.get('q') || '').trim();
      if (!kw) return jsonResponse({ q: '', items: [] });
      return jsonResponse({ q: kw, items: await suggest(kw) });
    }

    if (p === '/api/hotwords') {
      const d = await home();
      const words = [...new Set((d.hero || []).map((x) => x.name).filter(Boolean))].slice(0, 8);
      return jsonResponse({ words });
    }

    if (p === '/api/detail') {
      const key = q.get('key');
      const id = q.get('id');
      if (!key || !id) return jsonResponse({ error: 'key/id required' }, 400);
      const d = await detail(key, id);
      if (!d) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse(d);
    }

    if (p === '/api/related') {
      const name = q.get('name') || '';
      if (!name) return jsonResponse({ items: [] });
      return jsonResponse(await related(name, q.get('key') || '', q.get('id') || ''));
    }

    if (p === '/api/like') {
      return jsonResponse(await like(q.get('name') || '', q.get('cat') || ''));
    }

    if (p === '/api/stream') {
      const key = q.get('key');
      const id = q.get('id');
      const line = Math.max(0, Number(q.get('line')) || 0);
      const ep = Math.max(0, Number(q.get('ep')) || 0);
      const src = await sourceByKey(key);
      if (!src) return jsonResponse({ ok: false, reason: 'unknown source' }, 400);

      const cached = cache.get(`stream:${key}:${id}:${line}:${ep}`);
      if (cached) return jsonResponse(cached);

      const d = await detail(key, id);
      if (!d || !d.lines?.length) return jsonResponse({ ok: false, reason: 'no playable lines' }, 404);

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
      if (!r?.ok) return jsonResponse({ ok: false, reason: r?.reason || 'unavailable' }, 502);

      const payload = {
        ok: true,
        source: { key: src.key, name: src.name },
        lineIndex: r.lineIndex,
        lineName: r.lineName,
        episode: r.episode,
        raw: r.m3u8,
        url: proxyUrl(r.m3u8) + (r.referer ? '&r=' + b64u.encode(r.referer) : ''),
        lines: d.lines.map((l) => ({ from: l.from, count: l.episodes.length })),
      };
      cache.set(`stream:${key}:${id}:${line}:${ep}`, payload, 120_000);
      return jsonResponse(payload);
    }

    if (p === '/api/probe') {
      const r = await probeM3u8(q.get('u') || '', q.get('r') || '');
      return jsonResponse({ ok: r.ok, status: r.status });
    }

    if (p === '/api/health') {
      const all = await sources();
      const stats = await mapLimit(all, 5, async (s) => {
        const t0 = Date.now();
        const r = await cmsList(s, { cat: 'jp', page: 1 });
        return { key: s.key, name: s.name, ms: Date.now() - t0, ok: (r.list || []).length > 0, total: r.total };
      });
      return jsonResponse({ stats, at: new Date().toISOString() });
    }

    return jsonResponse({ error: 'unknown api' }, 404);
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, 500);
  }
}
