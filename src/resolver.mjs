// 播放地址解析：把 macCMS 的 share 页 / 网页播放页解析成真实 m3u8
import { fetchT, cache, absUrl, UA } from './util.mjs';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const M3U8_RE = /["'(]([^"'()\s\\]+\.m3u8[^"'()\s\\]*)["')]/g;

/** 从 HTML 提取候选播放地址 */
export function extractCandidates(html, pageUrl) {
  const out = [];
  const push = (u) => {
    if (!u) return;
    const s = String(u).trim();
    if (!s || s.startsWith('data:')) return;
    out.push(absUrl(s, pageUrl));
  };

  // 1) 播放器全局变量（macCMS 常见写法）
  for (const m of html.matchAll(/var\s+(?:main|url|video|videourl|m3u8)\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  // 2) player_aaaa
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
  // 3) JSON 字段
  for (const m of html.matchAll(/"(?:url|src|file|playurl|m3u8)"\s*:\s*"([^"]+\.m3u8[^"]*)"/g)) push(m[1]);
  // 4) 页面上任何 m3u8 字面量
  for (const m of html.matchAll(M3U8_RE)) push(m[1]);

  return [...new Set(out)];
}

/** 探测 m3u8 是否可播（拉前 1KB 校验 #EXTM3U） */
export async function probeM3u8(url, referer = '', timeout = 7000) {
  try {
    const r = await fetchT(url, {
      timeout,
      headers: {
        Range: 'bytes=0-2048',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const text = (await r.text()).slice(0, 2048);
    return { ok: text.includes('#EXTM3U'), status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

/** 解析一集：直链直接返回；网页地址抓取并提取 */
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
    const r = await fetchT(episodeUrl, { timeout: 12000, headers: { Referer: baseReferer } });
    html = await r.text();
  } catch (e) {
    return { ok: false, reason: '播放页抓取失败: ' + String(e.message || e) };
  }

  const cands = extractCandidates(html, episodeUrl).slice(0, 6);
  for (const u of cands) {
    const p = await probeM3u8(u, baseReferer, 6000);
    if (p.ok) {
      const res = { ok: true, m3u8: u, referer: baseReferer, direct: false, candidates: cands.length };
      cache.set(key, res, 600_000);
      return res;
    }
  }
  return { ok: false, reason: '未找到可用 m3u8', candidates: cands.length };
}

/** 逐线路回退，找一个能播的 */
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

export { UA };
