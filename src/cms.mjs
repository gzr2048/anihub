// macCMS V10 采集接口客户端
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, absUrl, cache, mapLimit } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, '..', 'data', 'sources.json');

export function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  raw.sources = (raw.sources || []).filter((s) => s.enabled !== false);
  return raw;
}

export const config = loadConfig();
export const sources = config.sources;

export function sourceByKey(key) {
  return sources.find((s) => s.key === key) || null;
}

export function publicSources() {
  return sources.map((s) => ({
    key: s.key,
    name: s.name,
    weight: s.weight,
    types: s.types,
    note: s.note || '',
  }));
}

/** 原始请求：拼参数并放宽类型 */
async function cms(src, params = {}, ttl = 60_000) {
  const url = new URL(src.api);
  const defaults = { ac: 'detail', pg: 1, ...params };
  for (const [k, v] of Object.entries(defaults)) {
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

/** 列表 / 分类翻页 */
export async function cmsList(src, { cat = 'jp', page = 1, wd = '', t } = {}) {
  const typeIds = t ? [t] : src.types?.[cat] || [];
  if (typeIds.length === 0) return { list: [], total: 0, page, pagecount: 0 };
  // 一个源同一分类可能有多个 type_id，取并集（一般是 1 个）
  const results = await mapLimit(typeIds, 3, (tid) =>
    cms(src, { ac: 'detail', t: tid, pg: page, wd }, 90_000),
  );
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

/** 关键词搜索（跨分类） */
export async function cmsSearch(src, wd, page = 1) {
  return cms(src, { ac: 'detail', wd, pg: page }, 120_000);
}

/** 单条详情 */
export async function cmsDetail(src, id) {
  const r = await cms(src, { ac: 'detail', ids: id }, 300_000);
  return r?.list?.[0] || null;
}

/** 最新入库（不带分类，用于健康检查/首页补充） */
export async function cmsLatest(src, page = 1) {
  return cms(src, { ac: 'detail', pg: page }, 60_000);
}

export { absUrl };
