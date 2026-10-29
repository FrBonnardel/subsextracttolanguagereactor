// Story context for Ollama: tab title/description of the video page plus a Wikipedia synopsis.
// Only short summaries are used, never scripts or transcripts.

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 600;
const MAX_SYNOPSIS = 900;
const CACHE_PREFIX = 'story:';
const WIKI_TIMEOUT_MS = 6000;
const API_USER_AGENT = 'HanziSubsReactor/0.1 (Chrome extension; subtitle translation context)';

const CJK = /[\u3400-\u9fff]/;
const SITE =
  /^(youtube|bilibili|哔哩哔哩|嗶哩嗶哩|爱奇艺|愛奇藝|iqiyi|优酷|youku|腾讯视频|騰訊視頻|wetv|mgtv|芒果tv|netflix|viki|西瓜视频|抖音|douyin|爱壹帆|愛壹帆|iyf(\.tv)?|.*影院|.*影视|.*视频网?|.*\.(com|tv|net|cc))$/i;
const EPISODE =
  /(第\s*[0-9零一二三四五六七八九十百]+\s*[集话話季部期回]|\b(ep|e|episode|season|s)\s*\.?\s*\d+\b|\bS\d+E\d+\b|\b\d{1,3}\s*集)/gi;
const BOILERPLATE =
  /(免费|免費|在线|在線|观看|觀看|播放|高清|超清|蓝光|藍光|全集|完整版|正片|官方|国语|國語|粤语|粵語|中字|中文字幕|最新|更新|预告|預告|电视剧|電視劇|动漫|動漫|电影|電影|\b(full|hd|4k|1080p|720p|online|free|watch|eng ?sub|multi ?sub)\b)/gi;
// Spaced separators always split; a bare "-" only splits when it isn't inside a Latin word ("Spider-Man").
const SEPARATOR = /\s+[-–—|·]\s+|[|｜_·•]|(?<![A-Za-z])-|-(?![A-Za-z])/;

export function clean(text, max) {
  const s = String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Turns a tab/video title into likely show names to search for, best first. */
export function titleCandidates(...titles) {
  const out = [];
  for (const raw of titles) {
    const t = clean(raw, MAX_TITLE);
    // 《...》 holds the actual work title; 【...】 / [...] / (...) usually hold tags ("中字", "4K", "官方").
    const quoted = t.match(/《([^》]+)》/);
    if (quoted) out.push(quoted[1].trim());
    const segments = t
      .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）|《|》/g, ' ')
      .split(SEPARATOR)
      .map((s) => s.trim())
      .filter((s) => s && !SITE.test(s))
      .map((s) => s.replace(EPISODE, ' ').replace(/[\s:：,，.。!！?？~]+$/g, '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.replace(BOILERPLATE, '').replace(/[\s\d\p{P}]/gu, '').length >= 2);
    out.push(...segments.slice(0, 2));
  }
  return [...new Set(out)].slice(0, 3);
}

const norm = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const baseTitle = (s) => s.replace(/\s*[（(][^）)]*[）)]\s*$/, ''); // "流星花园 (2018年电视剧)" -> "流星花园"
const SCREEN_WORK = /电视剧|電視劇|剧集|劇集|电影|電影|动画|動畫|动漫|動漫|网络剧|網絡劇|網路劇|综艺|綜藝|\b(tv|television|series|film|movie|anime|drama|donghua|miniseries)\b/i;

// A search hit only counts when its article title (minus the disambiguator) names exactly the searched work.
export function titlesMatch(query, article) {
  const q = norm(query);
  return !!q && q === norm(baseTitle(article));
}

/** Picks the best page from a MediaWiki generator=search result, or null. */
export function pickWikiPage(query, pages) {
  const candidates = [...(pages ?? [])]
    .sort((a, b) => a.index - b.index)
    .filter((p) => !p.pageprops || !('disambiguation' in p.pageprops))
    .filter((p) => [p.title, ...Object.values(p.varianttitles ?? {})].some((t) => titlesMatch(query, t)));
  return candidates.find((p) => SCREEN_WORK.test(`${p.title} ${p.description ?? ''}`)) ?? candidates[0] ?? null;
}

async function getJson(fetchImpl, url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WIKI_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'Api-User-Agent': API_USER_AGENT, ...headers } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up a short Wikipedia summary for one of the candidate titles.
 * @returns {Promise<object|null|undefined>} null when nothing matches, undefined when Wikipedia could not be reached
 */
export async function wikipediaSynopsis(candidates, fetchImpl = fetch) {
  try {
    return await lookup(candidates, fetchImpl);
  } catch {
    return undefined;
  }
}

async function lookup(candidates, fetchImpl) {
  for (const query of candidates) {
    const lang = CJK.test(query) ? 'zh' : 'en';
    const base = `https://${lang}.wikipedia.org`;
    const search = await getJson(
      fetchImpl,
      `${base}/w/api.php?action=query&format=json&formatversion=2&origin=*&generator=search&gsrlimit=8`
        + `&prop=info|description|pageprops&inprop=varianttitles&ppprop=disambiguation&gsrsearch=${encodeURIComponent(query)}`,
    );
    const page = pickWikiPage(query, search?.query?.pages);
    if (!page) continue;
    const summary = await getJson(
      fetchImpl,
      `${base}/api/rest_v1/page/summary/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      lang === 'zh' ? { 'Accept-Language': 'zh-cn' } : {},
    );
    if (!summary?.extract || summary.type === 'disambiguation') continue;
    return {
      title: summary.title ?? page.title,
      synopsis: clean(summary.extract, MAX_SYNOPSIS),
      url: summary.content_urls?.desktop?.page ?? '',
    };
  }
  return null;
}

export function formatStory({ title, description, wiki }) {
  const parts = [];
  if (title) parts.push(`Video title: ${title}`);
  if (description) parts.push(`Video description: ${description}`);
  if (wiki) parts.push(`Wikipedia synopsis of "${wiki.title}": ${wiki.synopsis}`);
  return parts.join('\n');
}

/**
 * @param {{page: string, title?: string, altTitle?: string, description?: string}} info  captured from the page
 * @returns {Promise<{story: string, wikiTitle: string, cached: boolean, complete: boolean}>} complete=false: Wikipedia unreachable, retry later
 */
export async function storyContext(info, fetchImpl = fetch, store = chrome.storage.session) {
  const title = clean(info.title || info.altTitle, MAX_TITLE);
  const description = clean(info.description, MAX_DESCRIPTION);
  const key = `${CACHE_PREFIX}${info.page}\u0000${title}`;
  const hit = (await store.get(key))[key];
  if (hit) return { ...hit, cached: true, complete: true };

  const wiki = await wikipediaSynopsis(titleCandidates(info.title, info.altTitle), fetchImpl);
  const result = { story: formatStory({ title, description, wiki }), wikiTitle: wiki?.title ?? '' };
  if (wiki !== undefined) await store.set({ [key]: result });
  return { ...result, cached: false, complete: wiki !== undefined };
}

/** Short stable tag so cached translations made with different story contexts don't collide. */
export function storyTag(story) {
  let h = 0x811c9dc5;
  for (let i = 0; i < story.length; i++) h = Math.imul(h ^ story.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
