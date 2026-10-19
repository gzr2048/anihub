/* ANIHUB 前端应用：hash 路由 + 数据渲染 */
import { mountPlayer, RATE_LIST, FIT_LIST } from './player.js';

// 用口令链接（?t=...）进来时，服务端已经种好 Cookie，这里把地址栏里的口令擦掉，
// 免得它留在历史记录、被截图、被复制分享出去。#hash 要原样保住。
(() => {
  try {
    if (!/[?&]t=/.test(location.search)) return;
    const u = new URL(location.href);
    u.searchParams.delete('t');
    history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
  } catch {}
})();

/** hls.js 只在真正开播时才拉，首页不用为它付 400KB */
let hlsBoot = null;
// iOS 的 Safari 原生就能放 m3u8，不需要 MSE 也不需要 hls.js。
// 不下这 400KB 对流量弱的手机意义不小，而且原生播放器的全屏/画中画更顺。
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function ensureHls() {
  if (IS_IOS) return Promise.resolve(null);
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsBoot) {
    hlsBoot = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = '/vendor/hls.min.js?v=__HLSV__';
      sc.async = true;
      sc.onload = () => res(window.Hls);
      sc.onerror = () => {
        hlsBoot = null;
        rej(new Error('播放器组件加载失败'));
      };
      document.head.append(sc);
    });
  }
  return hlsBoot;
}

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- DOM 工具 ---------------- */
export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const icon = (path, size = 16) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
};

const ICONS = {
  play: 'M8 5v14l11-7z',
  back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
  arrow: 'M9 6l6 6-6 6',
  empty: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  star: 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm10 17-5.2-5.2',
  fire: 'M12 2s4 4.4 4 8a4 4 0 0 1-8 0c0-1.2.5-2.3 1-3-2.6 1.6-4 4.3-4 7a7 7 0 0 0 14 0c0-5-7-12-7-12z',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4a8.8 8.8 0 0 0-.2-1.8l2-1.5-2-3.4-2.3 1a9 9 0 0 0-3-1.8L15 2H9l-.5 2.5a9 9 0 0 0-3 1.8l-2.3-1-2 3.4 2 1.5A8.8 8.8 0 0 0 3 12c0 .6.1 1.2.2 1.8l-2 1.5 2 3.4 2.3-1a9 9 0 0 0 3 1.8L9 22h6l.5-2.5a9 9 0 0 0 3-1.8l2.3 1 2-3.4-2-1.5c.1-.6.2-1.2.2-1.8z',
};

/* ---------------- 状态 ---------------- */
const store = {
  config: null,
  heroTimer: null,
  renderedRoute: '',
  progress: JSON.parse(localStorage.getItem('ah:progress') || '{}'),
};

function saveProgress() {
  localStorage.setItem('ah:progress', JSON.stringify(store.progress));
}
const progKey = (key, id) => `${key}:${id}`;

/* ---------------- 我的：收藏 / 进度 / 历史 ---------------- */
const FAV_KEY = 'ah:fav';
const PROG_MAX = 60;

function loadFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveFavs(list) {
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 200)));
}

const isFav = (key, id) => loadFavs().some((f) => String(f.key) === String(key) && String(f.id) === String(id));

/* ---------------- 我的：观看统计 ---------------- */
const STAT_KEY = 'ah:stats';
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STAT_KEY) || '{}');
    return {
      total: Number(s.total) || 0,
      days: s.days || {},
      eps: Number(s.eps) || 0,
      seen: Array.isArray(s.seen) ? s.seen : [],
    };
  } catch {
    return { total: 0, days: {}, eps: 0, seen: [] };
  }
}

function saveStats(s) {
  try {
    localStorage.setItem(STAT_KEY, JSON.stringify(s));
  } catch {}
}

/** 累加实际看过的秒数；epKey 用来算「看过多少集」，同一集只记一次 */
function addWatch(sec, epKey) {
  if (!(sec > 0)) return;
  const s = loadStats();
  s.total += sec;
  const d = dayKey();
  s.days[d] = (s.days[d] || 0) + sec;
  if (epKey && !s.seen.includes(epKey)) {
    s.seen.push(epKey);
    s.eps += 1;
    if (s.seen.length > 500) s.seen = s.seen.slice(-250);
  }
  const keys = Object.keys(s.days).sort();
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete s.days[k];
  saveStats(s);
}

function weekStats() {
  const s = loadStats();
  let sec = 0;
  let days = 0;
  const now = Date.now();
  for (let i = 0; i < 7; i += 1) {
    const v = s.days[dayKey(now - i * 86400000)] || 0;
    if (v > 0) days += 1;
    sec += v;
  }
  return { sec, days, total: s.total, eps: s.eps };
}

function fmtDur(sec) {
  const n = Math.max(0, Math.round(sec));
  if (n < 60) return `${n} 秒`;
  const m = Math.round(n / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function toggleFav(item) {
  const list = loadFavs();
  const i = list.findIndex((f) => String(f.key) === String(item.key) && String(f.id) === String(item.id));
  if (i >= 0) {
    list.splice(i, 1);
    saveFavs(list);
    return false;
  }
  list.unshift({
    key: item.key,
    id: item.id,
    name: item.name,
    pic: item.pic || '',
    year: item.year || '',
    cat: item.cat || '',
    catLabel: item.catLabel || '',
    remarks: item.remarks || '',
    at: Date.now(),
  });
  saveFavs(list);
  return true;
}

/** 进度里没看完的，按最近观看排序 */
function continueList() {
  return Object.entries(store.progress)
    .map(([pk, p]) => ({ pk, ...p }))
    .filter((p) => !p.done && (p.t || 0) > 5)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 全部观看记录（含看完的），按时间倒序 */
function historyList() {
  return Object.values(store.progress).sort((a, b) => (b.at || 0) - (a.at || 0));
}

function setProgress(pk, patch) {
  store.progress[pk] = { ...(store.progress[pk] || {}), ...patch, at: Date.now() };
  const keys = Object.keys(store.progress);
  if (keys.length > PROG_MAX) {
    keys.sort((a, b) => (store.progress[a].at || 0) - (store.progress[b].at || 0));
    for (const k of keys.slice(0, keys.length - PROG_MAX)) delete store.progress[k];
  }
  saveProgress();
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

/* ---------------- 请求 ---------------- */
async function api(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j.error || j.reason) msg = j.error || j.reason;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/* ---------------- 通用组件 ---------------- */
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 3200);
}

function card(item, index = 0, opts = {}) {
  const href = `#/a/${item.key}/${item.id}`;
  const poster = item.pic
    ? el('img', {
        src: item.pic,
        alt: item.name,
        loading: opts.eager ? 'eager' : 'lazy',
        fetchpriority: opts.eager ? 'high' : 'auto',
        decoding: 'async',
      })
    : el('div', { class: 'ph', text: (item.name || '?').slice(0, 1) });
  const img = el('div', { class: 'card-poster' }, poster, el('div', { class: 'card-play' }, el('span', {}, icon(ICONS.play, 20))));
  if (item.remarks) img.append(el('div', { class: 'card-remarks', text: item.remarks }));
  if (!opts.noFav && item.key != null && item.id != null) {
    const fav = el('button', {
      type: 'button',
      class: 'card-fav' + (isFav(item.key, item.id) ? ' on' : ''),
      title: '收藏',
      'aria-label': '收藏这部番',
      onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const on = toggleFav(item);
        fav.classList.toggle('on', on);
        toast(on ? '已加入收藏' : '已取消收藏');
      },
    }, icon(ICONS.star, 13));
    img.append(fav);
  }
  const sameCat = opts.cat && opts.cat === (item.cat === 'ai' ? 'cn' : item.cat);
  const badgeText = item.cat === 'cn' ? '国漫' : item.cat === 'us' ? '欧美' : item.cat === 'ai' ? '动态漫' : '';
  if (badgeText && !sameCat) {
    img.append(el('div', { class: 'card-badge' + (item.cat === 'cn' ? ' hot' : ''), text: badgeText }));
  }

  const sub = el('div', { class: 'card-sub' },
    el('span', { text: item.year || '年份未知' }),
    el('span', { class: 'sepdot' }),
    el('span', { text: item.area || '日本' }),
  );

  const node = el('a', {
    class: 'card',
    href,
    style: { animationDelay: Math.min(index * 22, 400) + 'ms' },
  }, img, el('div', { class: 'card-body' }, el('h3', { class: 'card-name', text: item.name || '未知番剧' }), sub));

  const imgEl = poster.nodeType === 1 && poster.tagName === 'IMG' ? poster : null;
  if (imgEl) {
    imgEl.addEventListener('error', () => {
      imgEl.replaceWith(el('div', { class: 'ph', text: (item.name || '?').slice(0, 1) }));
    }, { once: true });
  }
  return node;
}

function skeletonGrid(n = 12) {
  return el('div', { class: 'grid' }, ...Array.from({ length: n }, () =>
    el('div', { class: 'card sk-card' },
      el('div', { class: 'card-poster shimmer' }),
      el('div', { class: 'card-body' },
        el('div', { class: 'sk-line shimmer w80' }),
        el('div', { class: 'sk-line shimmer w60' }),
      ),
    )));
}

/** 空态里的行动按钮 */
function goBtn(text, href) {
  return el('a', { class: 'btn btn-ghost empty-act', href, text });
}

function emptyState(title, desc, action) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'icon' }, icon(ICONS.empty, 24)),
    el('h3', { text: title }),
    el('p', { text: desc || '' }),
    action || null,
  );
}

function errorState(err, retry) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'icon' }, icon(ICONS.empty, 24)),
    el('h3', { text: '加载失败' }),
    el('p', { text: String(err?.message || err || '网络异常') }),
    el('button', { class: 'btn btn-ghost', onclick: retry }, '重试'),
  );
}

/* ---------------- 首页 ---------------- */
function heroBlock(list) {
  if (!list.length) return null;
  let idx = 0;
  const bg = el('div', { class: 'hero-bg' });
  const kicker = el('div', { class: 'hero-kicker', text: '本周热门 · TRENDING' });
  const title = el('h1', { class: 'hero-title' });
  const meta = el('div', { class: 'hero-meta' });
  const desc = el('p', { class: 'hero-desc' });
  const playBtn = el('a', { class: 'btn btn-primary', href: '#' }, icon(ICONS.play, 16), '立即观看');
  const detailBtn = el('a', { class: 'btn btn-ghost', href: '#' }, '查看详情');
  const thumbs = el('div', { class: 'hero-thumbs' });

  const paint = (i) => {
    idx = (i + list.length) % list.length;
    const it = list[idx];
    const pic = it.pic || '';
    bg.style.backgroundImage = pic ? `url("${pic}")` : 'none';
    title.textContent = it.name;
    meta.replaceChildren(...[
      it.score ? el('span', { class: 'score', text: '★ ' + it.score.toFixed(1) }) : null,
      it.year ? el('span', { class: 'pill', text: it.year }) : null,
      it.area ? el('span', { class: 'pill', text: it.area }) : null,
      it.catLabel ? el('span', { class: 'pill', text: it.catLabel }) : null,
      it.remarks ? el('span', { text: it.remarks }) : null,
      el('span', { class: 'pill', text: it.source }),
    ].filter(Boolean));
    desc.textContent = it.content || '多个公开采集源同时检索，站内直接起播。当前线路不可用时会自动切到备用源，看到一半关掉也能接着看。';
    playBtn.href = `#/p/${it.key}/${it.id}/0/0`;
    detailBtn.href = `#/a/${it.key}/${it.id}`;
    [...thumbs.children].forEach((t, k) => t.classList.toggle('active', k === idx));
  };

  list.forEach((it, i) => {
    const t = el('button', {
      class: 'hero-thumb',
      type: 'button',
      'aria-label': it.name,
      onclick: () => { paint(i); restart(); },
    }, it.pic ? el('img', { src: it.pic, alt: '', loading: 'lazy' }) : null);
    thumbs.append(t);
  });

  const restart = () => {
    clearInterval(store.heroTimer);
    store.heroTimer = setInterval(() => paint(idx + 1), 7000);
  };
  paint(0);
  restart();

  return el('section', { class: 'hero', 'aria-label': '推荐' },
    bg,
    el('div', { class: 'hero-inner' },
      el('div', { class: 'hero-copy' }, kicker, title, meta, desc,
        el('div', { class: 'hero-actions' }, playBtn, detailBtn)),
      thumbs,
    ),
  );
}

function sectionBlock(sec, eager) {
  return el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, sec.title, el('small', { text: sec.sub || '' })),
      el('a', { class: 'section-link', href: `#/list/${sec.id}` }, '全部', icon(ICONS.arrow, 13)),
    ),
    el('div', { class: 'grid' },
      ...sec.items.slice(0, 20).map((it, i) =>
        card(it, i, { cat: sec.id, eager: Boolean(eager) && i < 8 }),
      ),
    ),
  );
}

const fmtCount = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万' : String(n || 0));

function homeSkeleton() {
  const n = (store.config?.sources || []).length;
  return el('div', {},
    el('p', { class: 'sk-note' }, n ? `正在并行聚合 ${n} 个采集源，首次打开要两三秒…` : '正在加载…'),
    el('div', { class: 'hero sk-hero' },
      el('div', { class: 'hero-inner' },
        el('div', { class: 'hero-copy' },
          el('div', { class: 'sk-line shimmer w40' }),
          el('div', { class: 'sk-hero-title shimmer' }),
          el('div', { class: 'sk-line shimmer w60' }),
          el('div', { class: 'sk-line shimmer w80' }),
        ),
      ),
    ),
    el('div', { class: 'section' },
      el('div', { class: 'section-head' }, el('div', { class: 'sk-line shimmer w20' })),
      skeletonGrid(10),
    ),
  );
}

async function pageHome(root) {
  root.replaceChildren(homeSkeleton());
  let data;
  try {
    data = await api('/api/home');
  } catch (e) {
    root.replaceChildren(errorState(e, () => pageHome(root)));
    return;
  }
  const frag = document.createDocumentFragment();
  const hero = heroBlock(data.hero || []);
  if (hero) frag.append(hero);
  const grid = el('div', {});
  (data.sections || []).forEach((sec, i) => grid.append(sectionBlock(sec, i === 0)));
  frag.append(grid);
  root.replaceChildren(frag);
}

/* ---------------- 分类页 ---------------- */
const CATS = [
  { id: 'jp', label: '日番' },
  { id: 'cn', label: '国漫' },
  { id: 'us', label: '欧美' },
  { id: 'ai', label: '漫剧' },
];

async function pageList(root, cat = 'jp', page = 1) {
  const catLabel = CATS.find((c) => c.id === cat)?.label || cat;
  root.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: catLabel + ' · 全库' }),
        el('p', { class: 'page-sub', text: '多线路聚合，自动挑选可用播放源' }),
      ),
      el('div', { class: 'tabs' }, ...CATS.map((c) =>
        el('a', { class: 'tab' + (c.id === cat ? ' active' : ''), href: `#/list/${c.id}` }, c.label))),
    ),
    skeletonGrid(18),
  );

  let data;
  try {
    data = await api(`/api/list?cat=${encodeURIComponent(cat)}&page=${page}`);
  } catch (e) {
    root.lastChild.replaceWith(errorState(e, () => pageList(root, cat, page)));
    return;
  }
  const items = data.items || [];
  const head = root.firstChild;
  head.append(el('div', { class: 'page-count', text: `第 ${page} 页 · ${items.length} 部` }));

  const grid = el('div', { class: 'grid' });
  const body = items.length
    ? grid
    : emptyState('这一页空空如也', '换个分类或返回上一页试试', el('a', { class: 'btn btn-ghost', href: '#/list/' + cat }, '回到第 1 页'));

  if (items.length) grid.append(...items.map((it, i) => card(it, i, { cat, eager: i < 8 })));

  const more = el('div', { class: 'load-more' });
  let nextPage = page + 1;
  let busy = false;
  let done = false;
  let shown = items.length;

  const setHint = () => {
    const hint = more.querySelector('.more-hint');
    if (hint) hint.textContent = `已显示 ${shown} 部，向下滚动继续加载`;
  };

  const loadMore = async () => {
    if (busy || done) return;
    busy = true;
    const btn = more.querySelector('.btn-more');
    if (btn) {
      btn.textContent = '加载中…';
      btn.disabled = true;
    }
    try {
      const d2 = await api(`/api/list?cat=${encodeURIComponent(cat)}&page=${nextPage}`);
      const more2 = d2.items || [];
      if (!more2.length) {
        done = true;
        more.replaceChildren(el('span', { class: 'more-hint', text: `已到最后一页，共 ${shown} 部` }));
        return;
      }
      grid.append(...more2.map((it, i) => card(it, i, { cat })));
      shown += more2.length;
      nextPage += 1;
      if (btn) {
        btn.textContent = `继续加载第 ${nextPage} 页`;
        btn.disabled = false;
      }
      setHint();
    } catch {
      if (btn) {
        btn.textContent = '加载失败，点击重试';
        btn.disabled = false;
      }
    } finally {
      busy = false;
    }
  };

  if (items.length) {
    more.append(
      el('button', { class: 'btn-more', onclick: loadMore }, `继续加载第 ${nextPage} 页`),
      el('span', { class: 'more-hint', text: `已显示 ${shown} 部，向下滚动继续加载` }),
    );
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      }, { rootMargin: '300px' });
      io.observe(more);
    }
  }

  root.lastChild.replaceWith(body);
  if (items.length) root.append(more);
}

/* ---------------- 搜索页 ---------------- */
const SEARCH_CATS = [
  { id: '', label: '全部' },
  { id: 'jp', label: '日番' },
  { id: 'cn', label: '国漫' },
  { id: 'us', label: '欧美' },
  { id: 'ai', label: '漫剧' },
];

function pushHistory(q) {
  if (!q) return;
  const list = JSON.parse(localStorage.getItem('ah:hist') || '[]').filter((x) => x !== q);
  list.unshift(q);
  localStorage.setItem('ah:hist', JSON.stringify(list.slice(0, 8)));
}

async function pageSearch(root, q, cat = '') {
  const head = el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title', text: q ? `搜索「${q}」` : '搜索番剧' }),
      el('p', {
        class: 'page-sub',
        text: q ? '跨全部采集源实时检索，同名番剧自动合并多线路' : '番剧名、剧场版、年份、别名都可以',
      }),
    ),
  );
  root.replaceChildren(head, skeletonGrid(18));
  if (!q) {
    root.lastChild.replaceWith(await searchLanding());
    return;
  }
  pushHistory(q);

  let data;
  try {
    data = await api('/api/search?q=' + encodeURIComponent(q) + (cat ? '&cat=' + cat : ''));
  } catch (e) {
    root.lastChild.replaceWith(errorState(e, () => pageSearch(root, q, cat)));
    return;
  }
  const items = data.items || [];
  const counts = (data.counts || []).filter((c) => c.n > 0);
  const bar = el('div', { class: 'head-bar' },
    el('div', { class: 'tabs' }, ...SEARCH_CATS.map((c) =>
      el('a', {
        class: 'tab' + (c.id === cat ? ' active' : ''),
        href: `#/search?q=${encodeURIComponent(q)}${c.id ? '&cat=' + c.id : ''}`,
      }, c.label))),
    counts.length
      ? el('div', { class: 'page-count', text: counts.map((c) => `${c.name} ${c.n}`).join(' · ') })
      : null,
  );
  root.insertBefore(bar, root.lastChild);

  if (!items.length) {
    const words = await api('/api/hotwords').then((d) => d.words || []).catch(() => []);
    root.lastChild.replaceWith(el('div', {},
      emptyState(
        cat ? '这个分类下没有结果' : '没有找到相关番剧',
        '换个关键词，或用更短的名字再试',
        el('div', { class: 'row-actions' },
          cat ? el('a', { class: 'btn btn-ghost', href: `#/search?q=${encodeURIComponent(q)}` }, '看全部分类') : null,
          el('a', { class: 'btn btn-ghost', href: '#/' }, '返回首页'),
        ),
      ),
      words.length ? hotWords(words) : null,
    ));
    return;
  }
  const grid = el('div', { class: 'grid' }, ...items.map((it, i) => card(it, i, { cat, eager: i < 8 })));
  root.lastChild.replaceWith(grid);

  // 结果多时继续翻页，避免一次拉太多源
  const more = el('div', { class: 'load-more' });
  let nextPage = 2;
  let busy = false;
  let done = items.length < 20;

  const setHint = (n) => {
    const hint = more.querySelector('.more-hint');
    if (hint) hint.textContent = `已显示 ${n} 部`;
  };

  const loadMore = async () => {
    if (busy || done) return;
    busy = true;
    const btn = more.querySelector('.btn-more');
    if (btn) {
      btn.textContent = '加载中…';
      btn.disabled = true;
    }
    try {
      const d2 = await api(
        `/api/search?q=${encodeURIComponent(q)}${cat ? '&cat=' + cat : ''}&page=${nextPage}`,
      );
      const more2 = d2.items || [];
      if (!more2.length) {
        done = true;
        const n = grid.children.length;
        more.replaceChildren(el('span', { class: 'more-hint', text: `共 ${n} 部，已全部显示` }));
        return;
      }
      grid.append(...more2.map((it, i) => card(it, i, { cat })));
      nextPage += 1;
      if (btn) {
        btn.textContent = '加载更多结果';
        btn.disabled = false;
      }
      setHint(grid.children.length);
    } catch {
      if (btn) {
        btn.textContent = '加载失败，点击重试';
        btn.disabled = false;
      }
    } finally {
      busy = false;
    }
  };

  if (!done) {
    more.append(
      el('button', { class: 'btn-more', onclick: loadMore }, '加载更多结果'),
      el('span', { class: 'more-hint', text: `已显示 ${items.length} 部` }),
    );
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      }, { rootMargin: '300px' });
      io.observe(more);
    }
    root.append(more);
  }
}

function hotWords(words) {
  return el('section', { class: 'section', style: { marginTop: '32px' } },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, '热门搜索', el('small', { text: '其它人正在看' })),
    ),
    el('div', { class: 'chip-row' }, ...words.map((w) =>
      el('a', { class: 'chip chip-link', href: `#/search?q=${encodeURIComponent(w)}` }, w))),
  );
}

async function searchLanding() {
  const hist = JSON.parse(localStorage.getItem('ah:hist') || '[]');
  const words = await api('/api/hotwords').then((d) => d.words || []).catch(() => []);
  return el('div', {},
    hist.length
      ? el('section', { class: 'section' },
        el('div', { class: 'section-head' },
          el('h2', { class: 'section-title' }, '最近搜索'),
          el('button', {
            class: 'section-link',
            onclick: () => { localStorage.removeItem('ah:hist'); render(); },
          }, '清空'),
        ),
        el('div', { class: 'chip-row' }, ...hist.map((w) =>
          el('a', { class: 'chip chip-link', href: `#/search?q=${encodeURIComponent(w)}` }, w))),
      )
      : null,
    words.length ? hotWords(words) : null,
  );
}

/**
 * 采集站的分集名 99.5% 都是「第01集」这种占位（实测 5 个源 375 个样本）。
 * 选集面板里一格一格重复「第01集」既占地方又没信息，这里只留序号；
 * 真有标题的（「第01集 残酷的世界」「第01-02集」）就照原样显示。
 */
function isPlaceholderEp(name) {
  const t = String(name || '').trim();
  if (!t) return true;
  if (/^\d+(\.\d+)?$/.test(t)) return true;
  if (/^第?\s*\d+\s*[集话話期]$/.test(t)) return true;
  if (/^(ep|episode)?\.?\s*\d+$/i.test(t)) return true;
  return false;
}

function epLabel(name, index) {
  if (!isPlaceholderEp(name)) return String(name);
  return String(index + 1).padStart(2, '0');
}

/* ---------------- 详情页 ---------------- */
async function pageDetail(root, key, id) {
  root.replaceChildren(skeletonGrid(8));
  let d;
  try {
    d = await api(`/api/detail?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`);
  } catch (e) {
    root.replaceChildren(errorState(e, () => pageDetail(root, key, id)));
    return;
  }

  const pk = progKey(key, id);
  const prog = store.progress[pk];
  const startEp = prog && prog.ep < d.episodeCount ? prog.ep : 0;
  const startLine = prog && prog.line < d.lines.length ? prog.line : 0;

  // 进过详情页就算「已看过更新」，把收藏里记的 remarks 对齐，NEW 角标随之消失
  const favList = loadFavs();
  const fi = favList.findIndex((f) => String(f.key) === String(key) && String(f.id) === String(id));
  if (fi >= 0 && d.remarks && favList[fi].remarks !== d.remarks) {
    favList[fi].remarks = d.remarks;
    saveFavs(favList);
  }

  const hero = el('div', { class: 'detail-hero' });
  if (d.pic) hero.style.setProperty('--pic', `url("${d.pic}")`);

  const poster = d.pic
    ? el('img', { src: d.pic, alt: d.name })
    : el('div', { class: 'ph', text: (d.name || '?').slice(0, 1) });

  const tags = el('div', { class: 'detail-tags' },
    el('span', { class: 'chip accent', text: d.catLabel || d.typeName || '番剧' }),
    d.year ? el('span', { class: 'chip', text: d.year }) : null,
    d.area ? el('span', { class: 'chip', text: d.area }) : null,
    d.lang ? el('span', { class: 'chip', text: d.lang }) : null,
    d.remarks ? el('span', { class: 'chip', text: d.remarks }) : null,
  );

  const watchHref = `#/p/${d.key}/${d.id}/${startLine}/${startEp}`;
  const actions = el('div', { class: 'detail-actions' },
    el('a', { class: 'btn btn-primary', href: watchHref },
      icon(ICONS.play, 16),
      prog && prog.t > 30 ? `继续观看 · ${d.lines[startLine]?.episodes[startEp]?.name || '第' + (startEp + 1) + '集'}` : '开始观看',
    ),
    el('button', {
      class: 'btn btn-ghost',
      onclick: () => {
        const ep = Math.max(0, d.episodeCount - 1);
        location.hash = `#/p/${d.key}/${d.id}/0/${ep}`;
      },
    }, '最新一集'),
    favButton({ key: d.key, id: d.id, name: d.name, pic: d.pic, year: d.year, cat: d.cat, catLabel: d.catLabel }),
  );

  hero.append(el('div', { class: 'detail-wrap' },
    el('div', { class: 'detail-poster' }, poster),
    el('div', { class: 'detail-main' },
      el('h1', { class: 'detail-title', text: d.name }),
      d.sub ? el('p', { class: 'page-sub', text: d.sub }) : null,
      tags,
      el('div', { class: 'detail-meta' },
        d.score ? el('span', {}, '评分 ', el('b', { text: d.score.toFixed(1) })) : null,
        el('span', {}, '集数 ', el('b', { text: d.episodeCount || '待补' })),
        el('span', {}, '线路 ', el('b', { text: d.lines.length })),
        el('span', {}, '来源 ', el('b', { text: d.source })),
        d.updatedAt ? el('span', {}, '更新 ', el('b', { text: d.updatedAt.slice(0, 10) })) : null,
      ),
      actions,
    ),
  ));

  /* 剧集面板 */
  let curLine = startLine;
  const linesBox = el('div', { class: 'lines' });
  const epsBox = el('div', { class: 'eps' });
  const epCount = el('span', { class: 'muted' });

  const renderEps = () => {
    const line = d.lines[curLine];
    if (!line) return;
    epsBox.replaceChildren(...line.episodes.map((ep, i) => {
      const p = store.progress[pk];
      const watched = p && p.line === curLine && i < p.ep;
      const isCur = p && p.line === curLine && i === p.ep;
      return el('button', {
        class: 'ep' + (isCur ? ' active' : '') + (watched ? ' watched' : ''),
        title: ep.name,
        onclick: () => { location.hash = `#/p/${d.key}/${d.id}/${curLine}/${i}`; },
      }, epLabel(ep.name, i));
    }));
    epCount.textContent = `${line.episodes.length} 集 · ${line.from}`;
  };

  d.lines.forEach((l, i) => {
    linesBox.append(el('button', {
      class: 'line-btn' + (i === curLine ? ' active' : ''),
      onclick: (e) => {
        curLine = i;
        [...linesBox.children].forEach((b, k) => b.classList.toggle('active', k === i));
        renderEps();
      },
    }, l.from, el('small', { text: `${l.episodes.length}集` })));
  });
  renderEps();

  const epsPanel = el('div', { class: 'panel' },
    el('h3', { class: 'panel-title' }, '选集', epCount),
    linesBox, epsBox,
  );

  const prose = el('div', { class: 'panel' },
    el('h3', { class: 'panel-title' }, '简介'),
    el('p', { class: 'prose' + (d.content ? '' : ' empty'), text: d.content || '暂无简介' }),
    d.actor ? el('p', { class: 'prose', style: { marginTop: '12px', fontSize: '13px' } }, '声优 / 演员：' + d.actor) : null,
    d.director ? el('p', { class: 'prose', style: { marginTop: '6px', fontSize: '13px' } }, '导演：' + d.director) : null,
  );

  const altBox = el('div', { class: 'panel' },
    el('h3', { class: 'panel-title' }, '其他线路', el('span', { class: 'muted', text: '同名番剧 · 跨站备份' })),
    el('div', { class: 'alt-srcs' }, el('div', { class: 'prose empty', text: '正在匹配其他资源站…' })),
  );

  const likePanel = el('div', { class: 'panel like-panel' },
    el('h3', { class: 'panel-title' }, '猜你喜欢', el('span', { class: 'muted', text: '同类高热度' })),
    el('div', { class: 'grid like-grid' }),
  );

  root.replaceChildren(hero, el('div', { class: 'detail-body' }, epsPanel, prose, altBox, likePanel));

  // 同类推荐
  api(`/api/like?name=${encodeURIComponent(d.name)}&cat=${encodeURIComponent(d.cat || '')}`)
    .then((items) => {
      const grid = likePanel.querySelector('.like-grid');
      if (!items.length) {
        likePanel.remove();
        return;
      }
      grid.replaceChildren(...items.map((it, i) => card(it, i, { eager: i < 6 })));
    })
    .catch(() => likePanel.remove());

  // 异步加载其他线路
  api(`/api/related?name=${encodeURIComponent(d.name)}&key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`)
    .then((items) => {
      const box = altBox.querySelector('.alt-srcs');
      if (!items.length) {
        box.replaceChildren(el('div', { class: 'prose empty', text: '暂无其他站点收录' }));
        return;
      }
      box.replaceChildren(...items.map((it) => el('a', {
        class: 'alt-src',
        href: `#/a/${it.key}/${it.id}`,
      },
        el('span', { class: 'src-badge', text: it.source }),
        el('span', { class: 'nm', text: it.name }),
        el('span', { class: 'mt', text: `${it.episodeCount} 集 · ${it.remarks || it.year || ''}` }),
        icon(ICONS.arrow, 14),
      )));
    })
    .catch(() => {
      altBox.querySelector('.alt-srcs').replaceChildren(el('div', { class: 'prose empty', text: '匹配失败' }));
    });
}

/* ---------------- 播放页 ---------------- */
async function pagePlay(root, key, id, line, ep) {
  root.replaceChildren(skeletonGrid(6));
  let d;
  try {
    d = await api(`/api/detail?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`);
  } catch (e) {
    root.replaceChildren(errorState(e, () => pagePlay(root, key, id, line, ep)));
    return;
  }

  const pk = progKey(key, id);
  const prog = store.progress[pk];
  let curLine = Math.min(Math.max(0, line || 0), Math.max(0, d.lines.length - 1));
  let curEp = Math.min(Math.max(0, ep || 0), Math.max(0, (d.lines[curLine]?.episodes.length || 1) - 1));
  let watchAnchor = 0;
  if (!line && !ep && prog) {
    curLine = Math.min(prog.line || 0, d.lines.length - 1);
    curEp = Math.min(prog.ep || 0, (d.lines[curLine]?.episodes.length || 1) - 1);
  }

  const titleEl = el('h1', { class: 'play-title' }, d.name, el('span', { class: 'epname' }));
  const srcEl = el('span', { class: 'play-src' });
  const video = el('video', { playsinline: '', controls: '', preload: 'metadata' });
  const msg = el('div', { class: 'stage-msg' });
  const pipBtn = el('button', { class: 'stage-tool', type: 'button', title: '画中画', hidden: '' },
    icon('M3 5h18v11h-7v2h3v2H7v-2h3v-2H3V5zm2 2v7h14V7H5z', 16));
  const gearBtn = el('button', { class: 'stage-tool', type: 'button', title: '播放设置' }, icon(ICONS.gear, 16));
  const tools = el('div', { class: 'stage-tools' }, pipBtn, gearBtn);
  const spPanel = el('div', { class: 'sp', hidden: '' });
  const stage = el('div', { class: 'stage' }, video, msg, tools, spPanel);
  const nextBox = el('div', { class: 'play-next' });

  const sideEps = el('div', { class: 'side-eps' });
  const sideLines = el('div', { class: 'side-lines' });
  const sideCount = el('span', { class: 'side-count' });
  const side = el('div', { class: 'play-side' },
    el('div', { class: 'side-head' }, '选集', sideCount),
    sideLines,
    sideEps,
  );

  const epNameOf = (l, e) => d.lines[l]?.episodes[e]?.name || `第${e + 1}集`;

  const markEp = () => {
    const list = [...sideEps.children];
    list.forEach((b, i) => b.classList.toggle('active', i === curEp));
    const active = list[curEp];
    if (active) active.scrollIntoView({ block: 'nearest' });
    titleEl.querySelector('.epname').textContent = epNameOf(curLine, curEp);
    srcEl.textContent = `${d.lines[curLine]?.from || ''} · ${d.source}`;
    document.title = `${d.name} ${epNameOf(curLine, curEp)} · ANIHUB`;
  };

  const renderSide = () => {
    const line = d.lines[curLine];
    sideCount.textContent = `${line?.episodes?.length || 0} 集 · ${line?.from || ''}`;
    sideLines.replaceChildren(...d.lines.map((l, i) =>
      el('button', {
        class: 'line-chip' + (i === curLine ? ' active' : ''),
        title: `${l.from} · ${l.episodes.length} 集`,
        onclick: () => {
          if (i === curLine) return;
          curLine = i;
          curEp = 0;
          renderSide();
          playTo(i, 0);
        },
      }, el('i', { class: 'dot' }), `${l.from}`, el('em', { text: l.episodes.length + '集' }))));
    sideEps.replaceChildren(...(line?.episodes || []).map((epi, i) =>
      el('button', {
        class: 'ep',
        title: epi.name,
        onclick: () => playTo(curLine, i),
      }, epLabel(epi.name, i))));
    markEp();
  };

  const updateHash = () => {
    try {
      history.replaceState(null, '', `#/p/${key}/${id}/${curLine}/${curEp}`);
    } catch {}
  };

  const player = mountPlayer(video, {
    msg,
    stage,
    nextBox,
    onEnded: () => {
      const total = d.lines[curLine]?.episodes.length || 0;
      if (curEp + 1 < total) showNext();
    },
    onProgress: (t, dur) => {
      if (!dur || !isFinite(dur)) return;
      // 只累加正常观看的增量，拖进度条造成的大跳不算
      if (t > watchAnchor && t - watchAnchor < 45) {
        addWatch(t - watchAnchor, `${key}:${id}:${curLine}:${curEp}`);
      }
      watchAnchor = t;
      const ratio = t / dur;
      const done = ratio > 0.985;
      const epName = epNameOf(curLine, curEp);
      setProgress(pk, {
        ep: curEp,
        line: curLine,
        t: done ? 0 : t,
        dur,
        done,
        epName,
        name: d.name,
        pic: d.pic,
        year: d.year || '',
        cat: d.cat || '',
        catLabel: d.catLabel || '',
        key,
        id,
      });
      const btn = sideEps.children[curEp];
      if (btn) {
        btn.classList.add('watched');
        btn.style.setProperty('--p', Math.min(100, ratio * 100).toFixed(1) + '%');
        if (done) btn.classList.add('done');
      }
    },
  });

  /* --- 播放设置：倍速 / 清晰度 / 画面 / 音量 / 画中画 --- */
  // 采集站的分辨率五花八门（1080x608 这种裁边很常见），按宽度归档更接近直觉
  const qLabel = (l) => {
    const w = l.width || 0;
    const h = l.height || 0;
    if (!w || !h) return '原画';
    // 只有标准 16:9 才配得上「1080P」这种叫法，裁边的直接报真实尺寸，别糊弄人
    if (w >= 1800 && h >= 1000) return '1080P';
    if (w >= 1200 && h >= 700) return '720P';
    return `${w}×${h}`;
  };

  let spOpen = false;
  const closeSp = () => {
    if (!spOpen) return;
    spOpen = false;
    spPanel.hidden = true;
    tools.classList.remove('open');
  };
  gearBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    spOpen = !spOpen;
    spPanel.hidden = !spOpen;
    tools.classList.toggle('open', spOpen);
  });
  pipBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    await player.togglePip();
  });
  spPanel.addEventListener('click', (ev) => ev.stopPropagation());
  const onDocClickSp = () => closeSp();
  document.addEventListener('click', onDocClickSp);

  const rateChips = RATE_LIST.map((r) => el('button', {
    class: 'sp-chip',
    type: 'button',
    dataset: { rate: String(r) },
    onclick: () => player.setRate(r),
  }, r === 1 ? '1×' : `${r}×`));

  const fitChips = FIT_LIST.map((f) => el('button', {
    class: 'sp-chip',
    type: 'button',
    dataset: { fit: f.id },
    onclick: () => player.setFit(f.id),
  }, f.label));

  const volVal = el('span', { class: 'sp-val', text: '100%' });
  const volRange = el('input', {
    class: 'sp-range',
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: '1',
  });
  volRange.addEventListener('input', (ev) => {
    ev.stopPropagation();
    player.setVolume(Number(volRange.value));
  });
  const volSec = el('section', { class: 'sp-sec' }, el('h4', {}, '音量', volVal), volRange);

  const qList = el('div', { class: 'sp-list' });
  const qSec = el('section', { class: 'sp-sec' }, el('h4', {}, '清晰度'), qList);

  spPanel.append(
    el('div', { class: 'sp-head' }, '播放设置'),
    el('section', { class: 'sp-sec' }, el('h4', {}, '倍速'), el('div', { class: 'sp-chips' }, ...rateChips)),
    qSec,
    el('section', { class: 'sp-sec' }, el('h4', {}, '画面'), el('div', { class: 'sp-chips' }, ...fitChips)),
    volSec,
  );

  const renderQuality = (s) => {
    const lv = s.levels || [];
    // 同一高度有多条码率时只留最高的那条
    const byH = new Map();
    for (const l of lv) {
      if (!l.height) continue;
      const old = byH.get(l.height);
      if (!old || l.bitrate > old.bitrate) byH.set(l.height, l);
    }
    const rows = [...byH.values()].sort((a, b) => b.height - a.height);
    if (!rows.length) {
      // iOS 走原生播放器，hls.js 不在场，拿不到码率列表 ——
      // 但系统控制条里其实有画质选项，说明一下免得以为没这功能
      if (IS_IOS) {
        qSec.hidden = false;
        qList.replaceChildren(
          el('div', { class: 'sp-note' }, 'iOS 用系统播放器，清晰度在它的控制条里切换'),
        );
      } else {
        qSec.hidden = true;
      }
      return;
    }
    qSec.hidden = false;

    // 采集站多是单码率，没得挑，但把当前分辨率亮出来，别让人以为没这功能
    if (rows.length === 1) {
      const only = rows[0];
      qList.replaceChildren(
        el('div', { class: 'sp-note' }, '这条线路只有一档'),
        el('button', { class: 'sp-item on', type: 'button' }, `原画 ${qLabel(only)}`,
          el('em', {}, `${Math.round(only.bitrate / 1000)}k`)),
      );
      return;
    }
    const cur = s.current >= 0 ? lv[s.current] : null;
    const curH = cur?.height || 0;
    qList.replaceChildren(
      el('button', { class: 'sp-item' + (s.auto ? ' on' : ''), type: 'button', onclick: () => player.setLevel(-1) }, '自动'),
      ...rows.map((r) =>
        el('button', {
          class: 'sp-item' + (!s.auto && curH === r.height ? ' on' : ''),
          type: 'button',
          onclick: () => player.setLevel(r.i),
        }, qLabel(r), el('em', {}, `${Math.round(r.bitrate / 1000)}k`))),
    );
  };

  player.onState?.((s) => {
    rateChips.forEach((c) => c.classList.toggle('on', Number(c.dataset.rate) === s.rate));
    fitChips.forEach((c) => c.classList.toggle('on', c.dataset.fit === s.fit));
    volSec.hidden = !s.canVolume;
    const pct = Math.round((s.muted ? 0 : s.volume) * 100);
    volVal.textContent = `${pct}%`;
    volRange.style.setProperty('--p', `${pct}%`);
    if (document.activeElement !== volRange) volRange.value = String(s.muted ? 0 : s.volume);
    pipBtn.hidden = !s.canPip;
    pipBtn.classList.toggle('on', s.pip);
    renderQuality(s);
  });

  /* --- 触控手势：双击 ±10s / 长按 3× / 竖直滑调音量亮度 / 横滑拖进度 --- */
  const hud = el('div', { class: 'gesture-hud', hidden: '' });
  const flashL = el('div', { class: 'seek-flash left' });
  const flashR = el('div', { class: 'seek-flash right' });
  stage.append(flashL, flashR, hud);

  let hudTimer = null;
  const showHud = (t) => {
    hud.textContent = t;
    hud.hidden = false;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hud.hidden = true;
    }, 1000);
  };

  // 亮度不落盘：用户临时压暗画面后忘掉，下次进来还是暗的会很困惑
  let bright = 1;
  const applyBright = () => {
    video.style.filter = bright >= 0.999 ? '' : `brightness(${bright.toFixed(2)})`;
  };

  const g = { active: false, x: 0, y: 0, mode: '', moved: false, pressing: false, base: null };
  let pressTimer = null;
  let lastTap = 0;
  let lastTapX = 0;

  const seekBy = (d) => {
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    video.currentTime = Math.min(dur - 1, Math.max(0, video.currentTime + d));
    showHud(`${d > 0 ? '+' : ''}${d} 秒`);
  };

  const onStageDown = (ev) => {
    if (ev.pointerType === 'mouse') return;
    if (ev.target.closest('.stage-tool, .sp, .stage-msg, .ep-nav, .play-next')) return;
    const rect = stage.getBoundingClientRect();
    // 底部留给原生控制条，别抢
    if (ev.clientY - rect.top > rect.height - 56) return;

    g.active = true;
    g.x = ev.clientX;
    g.y = ev.clientY;
    g.mode = '';
    g.moved = false;
    g.pressing = false;
    g.base = { t: video.currentTime, v: video.volume, b: bright };

    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!g.active || g.moved) return;
      g.pressing = true;
      player.holdRate(3);
      showHud('3× 倍速播放中');
    }, 420);
  };

  const onStageMove = (ev) => {
    if (!g.active || ev.pointerType === 'mouse') return;
    if (g.pressing) return;
    const dx = ev.clientX - g.x;
    const dy = ev.clientY - g.y;
    if (!g.mode) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) g.mode = 'seek';
      else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) g.mode = 'slide';
      else return;
      g.moved = true;
      clearTimeout(pressTimer);
      g.base = { t: video.currentTime, v: video.volume, b: bright };
    }
    const rect = stage.getBoundingClientRect();

    if (g.mode === 'seek') {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) return;
      const delta = (dx / rect.width) * Math.min(dur, 180);
      video.currentTime = Math.min(dur - 1, Math.max(0, g.base.t + delta));
      showHud(`${delta >= 0 ? '+' : ''}${Math.round(delta)} 秒`);
      return;
    }

    const k = -dy / (rect.height * 0.85);
    if (g.x - rect.left < rect.width / 2) {
      // 左半屏：音量
      const v = Math.min(1, Math.max(0, g.base.v + k));
      video.volume = v;
      video.muted = v === 0;
      showHud(`音量 ${Math.round(v * 100)}%`);
    } else {
      // 右半屏：画面亮度（不改系统亮度，只压视频本身）
      bright = Math.min(1.8, Math.max(0.35, g.base.b + k * 1.2));
      applyBright();
      showHud(`亮度 ${Math.round(bright * 100)}%`);
    }
  };

  const onStageUp = (ev) => {
    if (ev.pointerType === 'mouse' || !g.active) return;
    g.active = false;
    clearTimeout(pressTimer);

    if (g.pressing) {
      g.pressing = false;
      player.holdRate(0);
      showHud(`恢复 ${video.playbackRate.toFixed(2).replace(/\.?0+$/, '')}×`);
      return;
    }

    if (g.moved) {
      if (g.mode === 'slide') player.setVolume(video.volume);
      g.moved = false;
      g.mode = '';
      return;
    }

    // 双击：左退 10 秒，右进 10 秒
    const now = Date.now();
    const rect = stage.getBoundingClientRect();
    if (now - lastTap < 320 && Math.abs(ev.clientX - lastTapX) < 100) {
      lastTap = 0;
      const left = ev.clientX - rect.left < rect.width / 2;
      seekBy(left ? -10 : 10);
      const box = left ? flashL : flashR;
      box.classList.add('on');
      setTimeout(() => box.classList.remove('on'), 240);
    } else {
      lastTap = now;
      lastTapX = ev.clientX;
    }
  };

  const onStageCancel = () => {
    g.active = false;
    clearTimeout(pressTimer);
    if (g.pressing) {
      g.pressing = false;
      player.holdRate(0);
    }
    g.moved = false;
    g.mode = '';
  };

  stage.addEventListener('pointerdown', onStageDown);
  stage.addEventListener('pointermove', onStageMove);
  stage.addEventListener('pointerup', onStageUp);
  stage.addEventListener('pointercancel', onStageCancel);

  function showNext() {
    nextBox.replaceChildren(
      el('span', { text: `即将播放：${epNameOf(curLine, curEp + 1)}` }),
      el('button', { onclick: () => playTo(curLine, curEp + 1) }, '立即播放'),
      el('button', { class: 'btn-ghost', style: { background: 'transparent', border: '1px solid var(--line-2)' }, onclick: () => nextBox.remove() }, '取消'),
    );
    stage.append(nextBox);
    player.countdown(6, () => playTo(curLine, curEp + 1));
  }

  /* --- 播放失败处理：先换线，全挂再换站 --- */
  const failedLines = new Set();
  let jumping = false;
  let fatalBusy = false;

  const showFatal = (e, reason) => {
    msg.replaceChildren(
      el('div', { class: 'big', text: '这一集暂时播不了' }),
      el('div', { class: 'small', text: reason || '所有线路都试过了，资源站可能暂时不可用' }),
      el('div', { class: 'row-actions', style: { marginTop: '14px' } },
        el('button', { class: 'btn btn-ghost', onclick: () => { failedLines.clear(); playTo(curLine, e); } }, '重试全部线路'),
        el('button', { class: 'btn btn-ghost', onclick: () => { if (curEp + 1 < (d.lines[curLine]?.episodes.length || 0)) playTo(curLine, curEp + 1); } }, '看下一集'),
        el('a', { class: 'btn btn-ghost', href: `#/a/${key}/${id}` }, '回详情页'),
      ),
    );
    msg.style.display = 'flex';
  };

  const JUMP_KEY = 'ah:jumped';

  const jumpToOtherSite = async (e) => {
    if (jumping) return false;
    jumping = true;
    try {
      // 记下换过的站，避免全站阵亡时来回横跳
      const tried = new Set();
      try { JSON.parse(sessionStorage.getItem(JUMP_KEY) || '[]').forEach((k) => tried.add(k)); } catch {}
      tried.add(String(key));
      try { sessionStorage.setItem(JUMP_KEY, JSON.stringify([...tried].slice(-8))); } catch {}

      const items = await api(`/api/related?name=${encodeURIComponent(d.name)}&key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`);
      const it = items.find((x) => !tried.has(String(x.key)));
      if (!it) return false;
      const ep = Math.min(e, Math.max(0, (it.episodeCount || 1) - 1));
      toast(`本站线路全部中断，换到「${it.source}」继续播`);
      location.hash = `#/p/${it.key}/${it.id}/0/${ep}`;
      return true;
    } catch {
      return false;
    } finally {
      jumping = false;
    }
  };

  const handleFatal = async (li, e) => {
    if (fatalBusy) return;
    fatalBusy = true;
    failedLines.add(li);
    try {
      const next = d.lines.map((_, i) => i).find((i) => !failedLines.has(i));
      if (next !== undefined) {
        const name = d.lines[next]?.from || '备用线路';
        toast(`「${d.lines[li]?.from || '当前线路'}」中断，已切换到「${name}」`, true);
        await playTo(next, e, { resume: true });
        return;
      }
      if (await jumpToOtherSite(e)) return;
      showFatal(e, '所有线路和备份站点都连不上，过一会儿再试');
    } finally {
      fatalBusy = false;
    }
  };

  async function playTo(l, e, { resume = false } = {}) {
    curLine = l;
    curEp = e;
    updateHash();
    markEp();
    nextBox.remove();
    if (!resume) failedLines.clear();
    watchAnchor = 0;
    msg.replaceChildren(
      el('div', { class: 'spinner' }),
      el('div', { class: 'big', text: resume ? '正在切换线路…' : '正在解析播放线路…' }),
      el('div', { class: 'small', text: resume ? '当前线路不可用，自动挑选备用源' : '自动挑选可用源' }),
    );
    msg.style.display = 'flex';
    player.pauseAll();

    const order = [l, ...d.lines.map((_, i) => i).filter((i) => i !== l)];
    const tries = order.filter((i) => !failedLines.has(i));
    let lastErr = null;

    for (const li of tries.slice(0, 4)) {
      try {
        const s = await api(`/api/stream?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}&line=${li}&ep=${e}`);
        if (!s.ok) throw new Error(s.reason || '线路不可用');
        if (li !== curLine) {
          curLine = li;
          renderSide();
          updateHash();
          toast(`已自动切换到「${s.lineName || '备用线路'}」`);
        }
        srcEl.textContent = `${s.lineName} · ${s.source?.name || d.source}`;
        msg.style.display = 'none';
        try { sessionStorage.removeItem(JUMP_KEY); } catch {}
        await ensureHls().catch(() => {});
        await player.load(s.url, { onFatal: () => handleFatal(li, e) });
        try { await video.play(); } catch {}
        return;
      } catch (err) {
        lastErr = err;
        failedLines.add(li);
        console.warn('[stream]', li, err.message);
      }
    }

    // 本站线路全挂：换到其他资源站的同番
    if (await jumpToOtherSite(e)) return;
    showFatal(e, lastErr ? String(lastErr.message) : '资源站可能暂时不可用');
  }

  renderSide();

  root.replaceChildren(
    el('div', { class: 'play-page' },
      el('div', { class: 'play-top' },
        el('a', { class: 'back-btn', href: `#/a/${key}/${id}` }, icon(ICONS.back, 15), '返回详情'),
        titleEl,
        srcEl,
        favButton({ key, id, name: d.name, pic: d.pic, year: d.year, cat: d.cat, catLabel: d.catLabel }, 'btn btn-ghost btn-sm play-fav'),
      ),
      el('div', { class: 'play-grid' },
        stage,
        el('div', { class: 'ep-nav' },
          el('button', { class: 'ep-nav-btn', type: 'button', onclick: () => { if (curEp > 0) playTo(curLine, curEp - 1); else toast('已经是第一集'); } },
            icon(ICONS.back, 15), '上一集'),
          el('span', { class: 'ep-nav-pos', text: `第${String(curEp + 1).padStart(2, '0')}集 / ${d.lines[curLine]?.episodes.length || 0}` }),
          el('button', { class: 'ep-nav-btn', type: 'button', onclick: () => {
            const total = d.lines[curLine]?.episodes.length || 0;
            if (curEp + 1 < total) playTo(curLine, curEp + 1); else toast('已经是最后一集');
          } }, '下一集', icon(ICONS.next, 15)),
        ),
        side,
      ),
      el('div', { class: 'play-keys' },
        el('span', {}, el('kbd', { text: '空格' }), '播放/暂停'),
        el('span', {}, el('kbd', { text: '← →' }), '快退/快进 5s'),
        el('span', {}, el('kbd', { text: 'N' }), '下一集'),
        el('span', {}, el('kbd', { text: 'F' }), '全屏'),
        el('span', {}, el('kbd', { text: 'Esc' }), '退出全屏'),
      ),
      d.content ? el('div', { class: 'panel play-info' },
        el('div', { class: 'side-head' }, '番剧简介', el('span', {}, d.year || '', d.area ? ` · ${d.area}` : '')),
        el('p', { class: 'detail-intro clamp', text: d.content }),
        el('a', { class: 'back-btn info-more', href: `#/a/${key}/${id}` }, '查看完整详情与其它线路', icon(ICONS.back, 14)),
      ) : null,
    ),
  );

  // 键盘快捷键
  const isBtn = () => /^(BUTTON|A|SUMMARY)$/.test(document.activeElement?.tagName || '');

  const toggle = () => {
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
  };

  // 键盘/输入法差异：code 在部分环境为空，key 在中英切换时可能是 'Process'
  const hit = (ev, code, keys) => {
    if (ev.code === code) return true;
    const k = (ev.key || '').toLowerCase();
    return keys.some((x) => x === k || x === ev.key);
  };

  const onKey = (ev) => {
    // 输入法正在组词时，任何键都不接管，否则中文输入会被打断
    if (ev.isComposing || ev.keyCode === 229) return;

    // 焦点在输入控件里就放行，只把 Esc 解释成"退出输入"
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) {
      if (ev.key === 'Escape') ae.blur();
      return;
    }

    if (hit(ev, 'Space', [' ', 'spacebar'])) {
      ev.preventDefault();
      // 长按会连发 keydown，不挡掉就等于在播放/暂停之间疯狂抖动
      if (ev.repeat) return;
      // 焦点停在选集按钮上时，空格会顺手把那一集点开，先把焦点交还给页面
      if (isBtn()) document.activeElement.blur();
      toggle();
      return;
    }

    if (hit(ev, 'ArrowRight', ['arrowright'])) {
      ev.preventDefault();
      if (!ev.repeat) player.nudge(5);
      return;
    }
    if (hit(ev, 'ArrowLeft', ['arrowleft'])) {
      ev.preventDefault();
      if (!ev.repeat) player.nudge(-5);
      return;
    }
    if (hit(ev, 'KeyF', ['f'])) {
      ev.preventDefault();
      player.toggleFullscreen();
      return;
    }
    if (hit(ev, 'KeyN', ['n'])) {
      ev.preventDefault();
      if (ev.repeat) return;
      const total = d.lines[curLine]?.episodes.length || 0;
      if (curEp + 1 < total) playTo(curLine, curEp + 1);
      return;
    }
    if (hit(ev, 'Escape', ['escape'])) {
      if (document.body.classList.contains('is-fs')) player.toggleFullscreen();
    }
  };

  // 按钮的空格激活发生在 keyup，keydown 的 preventDefault 拦不住所有情况
  const onKeyUp = (ev) => {
    if (hit(ev, 'Space', [' ', 'spacebar']) && isBtn()) ev.preventDefault();
  };

  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  store.player = player;
  store.cleanup = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('click', onDocClickSp);
    clearTimeout(hudTimer);
    stage.removeEventListener('pointerdown', onStageDown);
    stage.removeEventListener('pointermove', onStageMove);
    stage.removeEventListener('pointerup', onStageUp);
    stage.removeEventListener('pointercancel', onStageCancel);
    try { player.destroy(); } catch {}
  };

  playTo(curLine, curEp);

  // 恢复进度
  if (prog && prog.t > 5 && prog.ep === curEp) {
    video.addEventListener('loadedmetadata', () => { try { video.currentTime = prog.t; } catch {} }, { once: true });
  }
}

/* ---------------- 收藏按钮 ---------------- */
function favButton(item, cls = 'btn btn-ghost') {
  const paint = () => {
    const on = isFav(item.key, item.id);
    btn.classList.toggle('on', on);
    btn.replaceChildren(icon(ICONS.star, 15), el('span', { text: on ? '已收藏' : '收藏' }));
    btn.title = on ? '从收藏里移除' : '加入收藏';
  };
  const btn = el('button', {
    class: cls + ' fav-btn',
    onclick: (ev) => {
      ev.preventDefault();
      const on = toggleFav(item);
      paint();
      toast(on ? '已加入收藏' : '已取消收藏');
    },
  });
  btn.dataset.favKey = item.key;
  btn.dataset.favId = String(item.id);
  paint();
  return btn;
}

/** 其它标签页改了收藏，这里跟着变 */
function refreshFavButtons() {
  document.querySelectorAll('.fav-btn').forEach((btn) => {
    const on = isFav(btn.dataset.favKey, btn.dataset.favId);
    btn.classList.toggle('on', on);
    btn.replaceChildren(icon(ICONS.star, 15), el('span', { text: on ? '已收藏' : '收藏' }));
  });
}

/* ---------------- 我的 ---------------- */
function meCard(p, index = 0) {
  const pct = p.dur ? Math.min(100, ((p.t || 0) / p.dur) * 100) : 0;
  const href = `#/p/${p.key}/${p.id}/${p.line || 0}/${p.ep || 0}`;
  const node = card(
    { key: p.key, id: p.id, name: p.name, pic: p.pic, year: p.year || '', area: '' },
    index,
    { noFav: true },
  );
  node.setAttribute('href', href);
  const poster = node.querySelector('.card-poster');
  if (poster) poster.append(el('div', { class: 'me-bar' }, el('i', { style: { width: pct.toFixed(1) + '%' } })));
  const sub = node.querySelector('.card-sub');
  if (sub) sub.replaceChildren(el('span', { class: 'me-ep', text: p.epName || `第${(p.ep || 0) + 1}集` }), el('span', { class: 'sepdot' }), el('span', { text: relTime(p.at) }));
  return node;
}

function histRow(p) {
  const pct = p.dur ? Math.min(100, Math.round(((p.t || 0) / p.dur) * 100)) : 0;
  const pic = p.pic
    ? el('img', { src: p.pic, alt: p.name, loading: 'lazy' })
    : el('div', { class: 'ph', text: (p.name || '?').slice(0, 1) });
  return el('div', { class: 'hist-row' },
    el('a', { class: 'hist-link', href: `#/p/${p.key}/${p.id}/${p.line || 0}/${p.ep || 0}` },
      el('div', { class: 'hist-pic' }, pic),
      el('div', { class: 'hist-body' },
        el('b', { text: p.name || '未知番剧' }),
        el('span', { text: `${p.epName || `第${(p.ep || 0) + 1}集`}${p.done ? ' · 已看完' : ` · 看到 ${pct}%`}` }),
      ),
      el('em', { class: 'hist-time', text: relTime(p.at) }),
    ),
    el('button', {
      class: 'hist-del',
      title: '从记录里删掉',
      onclick: () => { delete store.progress[p.pk || progKey(p.key, p.id)]; saveProgress(); render(); },
    }, '×'),
  );
}

function pageMe(root) {
  const cont = continueList();
  const favs = loadFavs();
  const hist = historyList();

  const head = el('div', { class: 'page-head' },
    el('h1', { class: 'page-title', text: '我的' }),
    el('p', { class: 'page-sub', text: '观看进度、收藏和历史只存这台设备的浏览器，不上传服务器。' }),
  );

  const contSec = el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, '继续观看', el('small', { text: cont.length ? `${cont.length} 部没看完` : '暂无进度' })),
      cont.length
        ? el('button', { class: 'link-btn', onclick: () => { cont.forEach((p) => delete store.progress[p.pk]); saveProgress(); render(); } }, '清空')
        : null,
    ),
    cont.length
      ? el('div', { class: 'grid' }, ...cont.map((p, i) => meCard(p, i)))
      : emptyState('还没有观看记录', '随便点开一集，进度会记在这里，回来接着看', goBtn('去发现几部', '#/')),
  );

  const favCount = el('small', { text: favs.length ? `${favs.length} 部` : '空' });
  const favGrid = el('div', { class: 'grid' },
    ...favs.map((f, i) => {
      const c = card(f, i, { noFav: true });
      c.dataset.favKey = String(f.key);
      c.dataset.favId = String(f.id);
      return c;
    }));

  const favSec = el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, '我的收藏', favCount),
      favs.length ? el('button', { class: 'link-btn', onclick: () => { saveFavs([]); render(); } }, '清空') : null,
    ),
    favs.length
      ? favGrid
      : emptyState('收藏夹是空的', '卡片右上角的星标，或详情页的「收藏」按钮，点一下就进来', goBtn('去逛逛', '#/')),
  );

  const histSec = el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, '观看历史', el('small', { text: hist.length ? `${hist.length} 条` : '空' })),
      hist.length ? el('button', { class: 'link-btn', onclick: () => { store.progress = {}; saveProgress(); render(); } }, '清空') : null,
    ),
    hist.length
      ? el('div', { class: 'hist-list' }, ...hist.map(histRow))
      : emptyState('还没有历史', '播放过的番剧会按时间排在这里', goBtn('开始看一部', '#/')),
  );

  const w = weekStats();
  const statCell = (label, value) =>
    el('div', { class: 'stat-cell' }, el('b', { text: value }), el('span', { text: label }));
  const statSec = el('section', { class: 'section' },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, '观看统计', el('small', { text: w.sec > 0 ? '最近 7 天' : '还没有数据' })),
    ),
    w.sec > 0 || w.total > 0
      ? el('div', { class: 'stat-grid' },
          statCell('本周观看', fmtDur(w.sec)),
          statCell('本周追番', `${w.days} 天`),
          statCell('累计看过', `${w.eps} 集`),
          statCell('累计时长', fmtDur(w.total)),
        )
      : emptyState('还没开始看', '播放时长和集数只记在这台设备，不上传', goBtn('去看点东西', '#/')),
  );

  // 版本 / 检查更新（app.manifest 填远端 JSON 地址，app.download 填下载页）
  const appCfg = store.config?.app || {};
  const version = String(appCfg.version || '');
  const b64u = (u) =>
    btoa(unescape(encodeURIComponent(u))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const remoteUrl = (u) => (window.__ANIHUB_LOCAL__ ? `/p?u=${b64u(u)}` : u);

  const checkBtn = el('button', {
    class: 'link-btn',
    onclick: async () => {
      if (appCfg.manifest) {
        try {
          const r = await fetch(remoteUrl(appCfg.manifest), { cache: 'no-store' });
          const j = await r.json();
          if (j.version && String(j.version) !== version) {
            toast(`发现新版本 ${j.version}`, true);
            const url = j.download || j.url || appCfg.download;
            if (url) window.open(url, '_blank');
          } else {
            toast('已经是最新版本');
          }
        } catch (e) {
          toast(`更新检查失败：${e.message}`, true);
        }
        return;
      }
      if (appCfg.download) {
        window.open(appCfg.download, '_blank');
        return;
      }
      toast('还没配更新地址：data/sources.json 里的 app.manifest / app.download');
    },
  }, '检查更新');

  const verBar = el('div', { class: 'ver-bar' },
    el('span', { text: `ANIHUB ${version || 'dev'}` }),
    el('i', { class: 'dot-sep' }),
    el('span', { text: window.__ANIHUB_LOCAL__ ? '手机版' : '电脑版' }),
    el('i', { class: 'dot-sep' }),
    checkBtn,
  );

  root.replaceChildren(el('div', { class: 'me-page' }, head, contSec, statSec, favSec, histSec, verBar));
  document.title = '我的 · ANIHUB';

  // 收藏的更新检查：拿采集站最新的 remarks 跟上次记下的比，变了就打 NEW
  if (favs.length) {
    (async () => {
      const fresh = new Map();
      await Promise.all(favs.slice(0, 24).map(async (f) => {
        try {
          const d = await api(`/api/detail?key=${encodeURIComponent(f.key)}&id=${encodeURIComponent(f.id)}`);
          const now = String(d?.remarks || '').trim();
          const old = String(f.remarks || '').trim();
          if (now && old && now !== old) fresh.set(`${f.key}:${f.id}`, now);
        } catch {}
      }));
      if (!fresh.size) return;

      const list = loadFavs();
      for (const f of list) {
        const now = fresh.get(`${f.key}:${f.id}`);
        if (now) {
          f.remarks = now;
          f.updated = Date.now();
        }
      }
      saveFavs(list);

      [...favGrid.querySelectorAll('.card')].forEach((c) => {
        const now = fresh.get(`${c.dataset.favKey}:${c.dataset.favId}`);
        if (!now) return;
        c.classList.add('has-new');
        const r = c.querySelector('.card-remarks');
        if (r) r.textContent = now;
      });
      favCount.textContent = `${favs.length} 部 · ${fresh.size} 部有更新`;
    })();
  }
}

/* ---------------- 路由 ---------------- */
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const query = new URLSearchParams(qs || '');
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'list') return { name: 'list', cat: parts[1] || 'jp', page: Number(parts[2] || 1) };
  if (parts[0] === 'search') return { name: 'search', q: query.get('q') || '', cat: query.get('cat') || '' };
  if (parts[0] === 'me') return { name: 'me' };
  if (parts[0] === 'a') return { name: 'detail', key: parts[1], id: parts[2] };
  if (parts[0] === 'p') {
    return {
      name: 'play',
      key: parts[1],
      id: parts[2],
      line: Number(parts[3] || 0),
      ep: Number(parts[4] || 0),
    };
  }
  return { name: 'home' };
}

function navActive(route) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const key = a.dataset.nav;
    const on =
      key === 'home'
        ? route.name === 'home'
        : key === 'me'
          ? route.name === 'me'
          : route.name === 'list' && route.cat === key;
    a.classList.toggle('active', on);
  });
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const root = $('#app');
  const route = parseRoute();

  if (store.cleanup) { try { store.cleanup(); } catch {} store.cleanup = null; }
  if (store.player) { try { store.player.destroy(); } catch {} store.player = null; }
  clearInterval(store.heroTimer);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  navActive(route);

  const input = $('#search-input');
  if (route.name === 'search') input.value = route.q;
  if (route.name !== 'play') document.title = 'ANIHUB · 全网番剧一站直看';

  // 从搜索框点进详情/播放后，焦点会一直留在搜索框里，
  // 键盘快捷键全部被"在输入框里打字"的判断吃掉——这里把焦点还给页面
  if (route.name !== 'search') {
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) ae.blur();
  }

  try {
    if (route.name === 'home') await pageHome(root);
    else if (route.name === 'list') await pageList(root, route.cat, route.page || 1);
    else if (route.name === 'search') await pageSearch(root, route.q, route.cat || '');
    else if (route.name === 'detail') await pageDetail(root, route.key, route.id);
    else if (route.name === 'play') await pagePlay(root, route.key, route.id, route.line, route.ep);
    else if (route.name === 'me') pageMe(root);
  } catch (e) {
    if (token === renderToken) {
      console.error(e);
      root.replaceChildren(errorState(e, () => render()));
    }
  }
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    store.config = await api('/api/config');
  } catch {
    store.config = { sources: [], site: {} };
  }

  const srcs = $('#foot-srcs');
  if (srcs) {
    srcs.replaceChildren(...(store.config.sources || []).map((s) =>
      el('span', { class: 'chip', title: s.note || '' }, s.name)));
    if (!(store.config.sources || []).length) srcs.replaceChildren(el('span', { class: 'chip', text: '未配置源' }));
  }

  // 其它标签页改了收藏或进度，这里跟上（storage 只在不含本页的标签间触发）
  window.addEventListener('storage', (e) => {
    if (e.key === 'ah:progress') {
      try { store.progress = JSON.parse(e.newValue || '{}'); } catch { store.progress = {}; }
      if (parseRoute().name === 'me') render();
    } else if (e.key === 'ah:fav') {
      refreshFavButtons();
      if (parseRoute().name === 'me') render();
    }
  });

  const clock = $('#foot-clock');
  const tick = () => {
    if (clock) clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);

  // 线路健康
  api('/api/health')
    .then((h) => {
      const ok = (h.stats || []).filter((s) => s.ok).length;
      const total = (h.stats || []).length;
      const live = $('#nav-live');
      const txt = $('#nav-live-text');
      if (txt) txt.textContent = `${ok}/${total} 线路在线`;
      if (live && ok < total) live.classList.add('warn');
    })
    .catch(() => {
      const txt = $('#nav-live-text');
      if (txt) txt.textContent = '线路异常';
    });

  // 搜索
  const form = $('#search-form');
  const input = $('#search-input');
  const box = $('#suggest');
  let sugTimer = null;
  let sugItems = [];
  let sugIdx = -1;

  const closeSuggest = () => {
    box.hidden = true;
    box.replaceChildren();
    sugItems = [];
    sugIdx = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const highlight = (i) => {
    sugIdx = i;
    [...box.querySelectorAll('.sug')].forEach((n, k) => n.classList.toggle('on', k === i));
  };

  const openSuggest = (items, kw) => {
    sugItems = items;
    sugIdx = -1;
    const rows = items.map((it) =>
      el('a', {
        class: 'sug',
        href: `#/a/${it.key}/${it.id}`,
        role: 'option',
        onmousedown: (ev) => ev.preventDefault(),
        onclick: () => { closeSuggest(); input.blur(); },
      },
        it.pic
          ? el('img', { class: 'sug-pic', src: it.pic, alt: '', loading: 'lazy' })
          : el('div', { class: 'sug-pic ph', text: (it.name || '?').slice(0, 1) }),
        el('div', { class: 'sug-body' },
          el('b', { text: it.name }),
          el('span', { text: [it.catLabel, it.year].filter(Boolean).join(' · ') || '番剧' }),
        ),
        el('span', { class: 'sug-go' }, icon(ICONS.arrow, 13)),
      ));
    box.replaceChildren(...rows,
      el('button', {
        class: 'sug-foot',
        type: 'submit',
        onmousedown: (ev) => ev.preventDefault(),
      },
        icon(ICONS.search, 13),
        el('span', { text: kw ? `搜索「${kw}」的全部结果` : '搜索全部结果' }),
      ));
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => {
    const v = input.value.trim();
    clearTimeout(sugTimer);
    if (!v) return closeSuggest();
    sugTimer = setTimeout(async () => {
      try {
        const d = await api('/api/suggest?q=' + encodeURIComponent(v));
        if (document.activeElement === input) openSuggest(d.items || [], v);
      } catch {
        closeSuggest();
      }
    }, 150);
  });

  input.addEventListener('keydown', (ev) => {
    if (box.hidden) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      highlight((sugIdx + 1) % sugItems.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      highlight((sugIdx - 1 + sugItems.length) % sugItems.length);
    } else if (ev.key === 'Enter' && sugIdx >= 0) {
      ev.preventDefault();
      box.children[sugIdx]?.click();
    }
  });

  input.addEventListener('blur', () => setTimeout(() => {
    if (!form.contains(document.activeElement)) closeSuggest();
  }, 120));

  document.addEventListener('pointerdown', (ev) => {
    if (!form.contains(ev.target)) closeSuggest();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) {
      location.hash = `#/search?q=${encodeURIComponent(q)}`;
      closeSuggest();
      input.blur();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === 'Escape' && document.activeElement === input) input.blur();
  });

  // 滚动状态
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  window.addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/');
  render();
}

boot();
