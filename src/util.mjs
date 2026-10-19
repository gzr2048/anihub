// 基础工具：HTTP、缓存、并发、编码、文本归一化
import fs from 'node:fs';
import path from 'node:path';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 带超时的 fetch（返回 Response） */
export async function fetchT(url, { timeout = 12000, headers = {}, method = 'GET', body, redirect = 'follow' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, {
      method,
      body,
      redirect,
      signal: ac.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时的 fetch + JSON 解析；失败返回 null，不抛错 */
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

/** 极简 TTL + LRU 缓存，带 in-flight 去重、stale-while-revalidate 与可选落盘 */
export class Cache {
  constructor(max = 700, { file = '', keys = null, flushMs = 2500, maxFileBytes = 8 * 1024 * 1024 } = {}) {
    this.max = max;
    this.map = new Map();
    this.inflight = new Map();
    this.file = file;
    this.persistKeys = keys;
    this.flushMs = flushMs;
    this.maxFileBytes = maxFileBytes;
    this.timer = null;
    this.stats = { hits: 0, misses: 0, saved: 0, loaded: 0 };
  }

  _persistent(key) {
    if (!this.file) return false;
    if (!this.persistKeys) return true;
    return this.persistKeys.some((p) => (p instanceof RegExp ? p.test(key) : key.startsWith(p)));
  }

  /** 读盘：只恢复未过期且属于白名单的条目 */
  async load() {
    if (!this.file) return 0;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();
      let n = 0;
      for (const [k, v] of Object.entries(parsed.entries || {})) {
        if (!v || v.exp <= now) continue;
        if (!this._persistent(k)) continue;
        this.map.set(k, { val: v.val, exp: v.exp });
        n += 1;
      }
      this.stats.loaded = n;
      return n;
    } catch {
      return 0;
    }
  }

  _scheduleFlush() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** 立即落盘（同步写临时文件后 rename，避免断电写坏） */
  flush() {
    if (!this.file) return 0;
    const now = Date.now();
    const entries = {};
    let bytes = 0;
    for (const [k, v] of this.map) {
      if (v.exp <= now || !this._persistent(k)) continue;
      entries[k] = { val: v.val, exp: v.exp };
      bytes += JSON.stringify(v.val).length;
      if (bytes > this.maxFileBytes) break;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: now, entries }));
      fs.renameSync(tmp, this.file);
      this.stats.saved = Object.keys(entries).length;
      return this.stats.saved;
    } catch {
      return 0;
    }
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) {
      this.stats.misses += 1;
      return undefined;
    }
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    // LRU: 命中后移到末尾
    this.map.delete(key);
    this.map.set(key, hit);
    this.stats.hits += 1;
    return hit.val;
  }
  set(key, val, ttlMs) {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, { val, exp: Date.now() + ttlMs });
    if (this._persistent(key)) this._scheduleFlush();
    return val;
  }
  /**
   * 取缓存；过期但仍在 swr 窗口内时直接返回旧值并在后台刷新。
   * 同一 key 的并发请求只穿透一次。
   */
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
            if (v !== undefined && v !== null) this.set(key, v, ttlMs);
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
        if (val !== undefined && val !== null) this.set(key, val, ttlMs);
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

const CACHE_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data', 'cache.json');

export const cache = new Cache(700, {
  file: process.env.ANIHUB_CACHE === '0' ? '' : CACHE_FILE,
  // 只落盘「冷启动要现抓」的聚合结果；详情页与流地址变化快，不白存
  keys: [/^home:/, /^list:/, /^search:/, /^like:/, /^sug:/, /^hot:/],
  flushMs: 3000,
  maxFileBytes: 8 * 1024 * 1024,
});

/** 并发受限的 map */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export const b64u = {
  encode(s) {
    return Buffer.from(String(s), 'utf8').toString('base64url');
  },
  decode(s) {
    try {
      return Buffer.from(String(s), 'base64url').toString('utf8');
    } catch {
      return '';
    }
  },
};

/** 名称归一化：去空白、标点、全角，小写 */
export function normName(s) {
  const CN = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/(动画版|动漫版|国漫版|普通话版|国语版|日语版|中配版|高清版|完整版)/g, '')
    // 第X季/部/期 → 数字，便于「2」与「第二季」对齐
    .replace(/第([一二三四五六七八九十0-9]+)[季部期]/g, (_m, n) => (CN[n] || n))
    .replace(/[·・:：!！?？,，.。'"“”‘’()（）\[\]【】\-—_~～/\\|]/g, '')
    .replace(/(season|s)(\d+)/g, '$2')
    .replace(/(动漫|动画|番剧|全集)$/g, '');
}

/** 名称相似度（0~1），用于跨源同番匹配 */
export function simName(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.62 + 0.3 * ratio;
  }
  // 字符二元组 Dice 系数
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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
