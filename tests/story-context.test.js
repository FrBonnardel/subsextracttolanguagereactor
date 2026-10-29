import assert from 'node:assert/strict';
import test from 'node:test';
import { titleCandidates, titlesMatch, pickWikiPage, wikipediaSynopsis, storyContext, formatStory } from '../extension/background/story-context.js';

test('titleCandidates strips site names, tags and episode numbers', () => {
  assert.deepEqual(titleCandidates('全职法师第7季-02-免费在线观看-爱壹帆'), ['全职法师']);
  assert.deepEqual(titleCandidates('(3) Spider-Man: Homecoming - YouTube')[0], 'Spider-Man: Homecoming');
  assert.deepEqual(titleCandidates('【中字】流星花园 第12集 - YouTube')[0], '流星花园');
  assert.deepEqual(titleCandidates('斗罗大陆 第2季 第35话_哔哩哔哩_bilibili')[0], '斗罗大陆');
  assert.equal(titleCandidates('电视剧《琅琊榜》EP05 官方高清')[0], '琅琊榜');
  assert.equal(titleCandidates('The Untamed EP 12 | WeTV')[0], 'The Untamed');
});

test('titlesMatch accepts the same work and rejects unrelated hits', () => {
  assert.ok(titlesMatch('流星花园', '流星花园 (2018年电视剧)'));
  assert.ok(titlesMatch('The Untamed', 'The Untamed (TV series)'));
  assert.ok(!titlesMatch('The Untamed', 'Untamed (TV series)'));
  assert.ok(!titlesMatch('流星花园', '花'));
  assert.ok(!titlesMatch('琅琊榜', '琅琊榜之风起长林'));
  assert.ok(!titlesMatch('琅琊榜', '三国演义'));
});

test('pickWikiPage matches variant titles, skips disambiguation pages and prefers screen works', () => {
  const pages = [
    { index: 2, title: '琅琊榜', pageprops: { disambiguation: '' } },
    { index: 4, title: '瑯琊榜 (小說)', varianttitles: { 'zh-cn': '琅琊榜 (小说)' }, description: '网络小说' },
    { index: 1, title: '瑯琊榜 (電視劇)', varianttitles: { 'zh-cn': '琅琊榜 (电视剧)' } },
    { index: 3, title: '琅琊榜之风起长林' },
  ];
  assert.equal(pickWikiPage('琅琊榜', pages).title, '瑯琊榜 (電視劇)');
  assert.equal(pickWikiPage('琅琊榜', pages.slice(0, 2)).title, '瑯琊榜 (小說)');
  assert.equal(pickWikiPage('三国', pages), null);
});

function fakeFetch(pages) {
  const urls = [];
  const impl = async (url) => {
    urls.push(url);
    const body = pages.find(([match]) => url.includes(match))?.[1];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  return { impl, urls };
}

test('wikipediaSynopsis searches zh.wikipedia for Chinese titles and returns the summary', async () => {
  const { impl, urls } = fakeFetch([
    ['generator=search', { query: { pages: [{ index: 1, title: '琅琊榜 (电视剧)' }] } }],
    ['page/summary/', { title: '琅琊榜 (电视剧)', extract: '梅长苏化名苏哲，回到金陵……', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/x' } } }],
  ]);
  const res = await wikipediaSynopsis(['琅琊榜'], impl);
  assert.equal(res.title, '琅琊榜 (电视剧)');
  assert.match(res.synopsis, /梅长苏/);
  assert.ok(urls[0].startsWith('https://zh.wikipedia.org/w/api.php'));
  assert.ok(urls[1].includes(encodeURIComponent('琅琊榜_(电视剧)')));
});

test('wikipediaSynopsis ignores non-matching search hits and reports unreachable Wikipedia', async () => {
  const { impl } = fakeFetch([['generator=search', { query: { pages: [{ index: 1, title: '完全无关' }] } }]]);
  assert.equal(await wikipediaSynopsis(['琅琊榜'], impl), null);
  assert.equal(await wikipediaSynopsis(['琅琊榜'], async () => { throw new Error('offline'); }), undefined);
  assert.equal(await wikipediaSynopsis(['琅琊榜'], async () => ({ ok: false, status: 429 })), undefined);
});

test('storyContext does not cache a lookup that failed to reach Wikipedia', async () => {
  const data = {};
  const store = { get: async (k) => ({ [k]: data[k] }), set: async (v) => Object.assign(data, v) };
  const res = await storyContext({ page: 'p', title: '琅琊榜' }, async () => ({ ok: false, status: 429 }), store);
  assert.deepEqual(res, { story: 'Video title: 琅琊榜', wikiTitle: '', cached: false, complete: false });
  assert.deepEqual(data, {});
});

test('storyContext combines page details with the synopsis and caches per page', async () => {
  const data = {};
  const store = { get: async (k) => ({ [k]: data[k] }), set: async (v) => Object.assign(data, v) };
  const { impl, urls } = fakeFetch([
    ['generator=search', { query: { pages: [{ index: 1, title: '琅琊榜' }] } }],
    ['page/summary/', { title: '琅琊榜', extract: '架空历史剧。' }],
  ]);
  const info = { page: 'https://v.example/1', title: '琅琊榜 第1集', description: '梅长苏 回京\n\n复仇 https://x.y/z' };
  const first = await storyContext(info, impl, store);
  assert.equal(first.cached, false);
  assert.equal(first.story, formatStory({
    title: '琅琊榜 第1集',
    description: '梅长苏 回京 复仇',
    wiki: { title: '琅琊榜', synopsis: '架空历史剧。' },
  }));
  const second = await storyContext(info, impl, store);
  assert.equal(second.cached, true);
  assert.equal(urls.length, 2);
});
