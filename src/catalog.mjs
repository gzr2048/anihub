// 资源聚合层：归一化、去重、首页分区、搜索、详情、跨源同番
import { sources, sourceByKey, cmsList, cmsSearch, cmsDetail } from './cms.mjs';
import { absUrl, cache, mapLimit, normName, simName, stripTags } from './util.mjs';

const CAT_LABEL = { jp: '日番', cn: '国漫', us: '欧美', ai: 'AI漫剧' };

function pic(src, v) {
  const raw = v.vod_pic || v.vod_pic_slide || '';
  if (!raw) return '';
  // 部分源给的是相对路径
  let p = absUrl(raw, src.api);
  // 统一走图片代理，规避防盗链
  return '/api/img?u=' + encodeURIComponent(p);
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

/**
 * 列表类接口的卡片只需要这几个字段。
 * content / actor / director / en / class / lang 只有详情页用得上，
 * 留在列表里每条白扔上百字节，翻页一多就是几十 KB。
 */
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

  // 采集站常用 "--" / "-" 占位，不算简介
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

/** 归一化详情（含线路与剧集） */
export function normalizeDetail(src, v) {
  const base = normalize(src, v);
  if (!base) return null;
  base.lines = playUrls(v);
  base.episodeCount = base.lines.reduce((m, l) => Math.max(m, l.episodes.length), 0);
  return base;
}

function dedupeKey(it) {
  // 仅按归一化名称去重：不同源的年份字段经常缺失或错填，用年份做 key 会产生大量重复卡片
  return normName(it.name);
}

/** 合并多源条目：同名同年的来自不同源，保留权重高的作为主项，其余作为备用线路 */
export function mergeItems(groups) {
  const map = new Map();
  for (const g of groups) {
    for (const it of g.items || []) {
      const k = dedupeKey(it);
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

/** 首页分区 */
export async function home() {
  return cache.wrap(
    'home:v4',
    180_000,
    async () => {
      const plan = [
        { cat: 'jp', page: 1 },
        { cat: 'cn', page: 1 },
        { cat: 'us', page: 1 },
        { cat: 'ai', page: 1 },
      ];
      const tasks = [];
      for (const p of plan) {
        // 只有配置了该分类的源才参与，避免无谓请求
        for (const s of sources) {
          if (!s.types || !s.types[p.cat]?.length) continue;
          tasks.push({ ...p, src: s });
        }
      }
      const results = await mapLimit(tasks, 12, async (t) => {
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
        for (const it of r.items) {
          if (it.cat && byCat[it.cat]) byCat[it.cat].push(it);
        }
      }
      const clean = (arr) =>
        mergeItems([{ items: arr }])
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 42);

      const jp = clean(byCat.jp);
      const cn = clean(byCat.cn);
      const us = clean(byCat.us);
      const ai = clean(byCat.ai);

      // 热度：多源同时收录 + 近期更新 + 评分
      const hotScore = (it) => {
        const alts = (it.alt || []).length;
        const t = Date.parse((it.updatedAt || '').replace(' ', 'T') + '+08:00') || 0;
        const days = t ? Math.max(0, (Date.now() - t) / 86400000) : 999;
        const fresh = Math.max(0, 4 - Math.min(days, 4));
        return alts * 1.6 + fresh * 1.2 + (it.score || 0) * 0.1;
      };
      // 跨源译名差异会残留同番，hero 内再做一次相似度去重
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
          sources: sources.length,
          catalog: catalogSize,
          fetched: results.reduce((n, r) => n + (r?.items?.length || 0), 0),
        },
      };
    },
    { swr: 600_000 },
  );
}

/** 分类列表（分页 + 多源聚合） */
export async function listCategory({ cat = 'jp', page = 1 } = {}) {
  const key = `list:${cat}:${page}`;
  return cache.wrap(
    key,
    180_000,
    async () => {
      const results = await mapLimit(sources, 7, async (s) => {
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
      const items = mergeItems(results).sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
      return { cat, page, items: items.map(lite), total: results.reduce((n, r) => n + (r.items?.length || 0), 0) };
    },
    { swr: 600_000 },
  );
}

/** 跨源搜索 */
export async function searchAll(q, { page = 1, cat = '' } = {}) {
  const kw = String(q || '').trim();
  if (!kw) return { q: kw, items: [], counts: [] };
  const key = `search:${kw.toLowerCase()}:${page}`;
  const data = await cache.wrap(
    key,
    150_000,
    async () => {
      const results = await mapLimit(sources, 7, async (s) => {
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
        return { items, rawCount: list.length };
      });
      const flat = results.flatMap((r) => r.items);
      // 按相似度 + 更新时间排序
      flat.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const items = mergeItems([{ items: flat }]).map(lite);
      return {
        q: kw,
        items,
        counts: sources.map((s, i) => ({ key: s.key, name: s.name, n: results[i]?.items.length || 0 })),
      };
    },
    { swr: 600_000 },
  );
  if (!cat) return data;
  const items = data.items.filter((it) => it.cat === cat);
  return { ...data, items, cat };
}

/** 搜索联想：先本地匹配首页聚合结果，不足时用最快的几个源做一次轻量远端检索 */
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

  // 1) 本地池
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

  // 2) 远端补全（只打权重最高的 3 个源，避免输入时等待过久）
  const remote = await cache.wrap(
    `sug:${nk}`,
    300_000,
    async () => {
      const picks = [...sources].sort((a, b) => b.weight - a.weight).slice(0, 2);
      const groups = await mapLimit(picks, 2, async (s) => {
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

/**
 * 分集名清洗放在前端做（public/app.js 的 epLabel）。
 * 后端原本想跨源补标题，但实测 5 个源 375 个样本里 99.5% 都是「第01集」这种占位，
 * 源头就没有标题可补 —— 补一轮要额外搜 6 个源，白白把详情页从 0.3s 拖到 3s，不划算。
 */

/** 详情 */
export async function detail(key, id) {
  const src = sourceByKey(key);
  if (!src) return null;
  const ck = `detail:${key}:${id}`;
  return cache.wrap(ck, 240_000, async () => {
    const v = await cmsDetail(src, id);
    return normalizeDetail(src, v);
  });
}

/** 跨源同番（同名或高相似度），返回带剧集的备用源 */
export async function related(name, excludeKey, excludeId) {
  const key = `rel:${normName(name)}:${excludeKey}:${excludeId}`;
  return cache.wrap(key, 420_000, async () => {
    const results = await mapLimit(sources, 5, async (s) => {
      const r = await cmsSearch(s, name, 1);
      const list = r?.list || [];
      const best = list
        .map((v) => ({ v, sco: simName(name, v.vod_name || '') }))
        .filter((x) => x.sco >= 0.72 && x.v.vod_type_name !== '电影解说')
        .sort((a, b) => b.sco - a.sco)[0];
      if (!best) return null;
      const d = await cmsDetail(s, best.v.vod_id);
      if (!d) return null;
      return normalizeDetail(s, d);
    });
    return results
      .filter(Boolean)
      .filter((d) => !(d.key === excludeKey && String(d.id) === String(excludeId)))
      .sort((a, b) => (sourceByKey(b.key)?.weight || 0) - (sourceByKey(a.key)?.weight || 0));
  });
}

export async function sourceStats() {
  return mapLimit(sources, 5, async (s) => {
    const t0 = Date.now();
    const r = await cmsList(s, { cat: 'jp', page: 1 });
    return { key: s.key, name: s.name, ms: Date.now() - t0, ok: (r.list || []).length > 0, total: r.total };
  });
}

/** 详情页「猜你喜欢」：从首页池子取同类，排除当前番剧 */
export async function like(name, cat) {
  const nk = normName(name || '');
  const key = `like:${cat || 'jp'}:${nk}`;
  return cache.wrap(key, 300_000, async () => {
    const homeData = await home();
    const secs = homeData.sections || [];
    const first = secs.filter((s) => !cat || s.id === cat);
    const rest = secs.filter((s) => cat && s.id !== cat);
    const pool = [...first, ...rest].flatMap((s) => s.items || []);
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
