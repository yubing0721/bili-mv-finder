/**
 * 后端代理服务
 *
 * 为什么需要一个后端：B站 的搜索接口有风控，需要 WBI 签名 + 有效 cookie，
 * 而且需要限流、重试、缓存。把这些放在服务端，App 端就只需要一个干净的 HTTP 接口。
 *
 * 零第三方依赖，只用 Node 内置模块，方便部署到任何地方（含 Vercel / 自己服务器 / Docker）。
 *
 * 启动：node src/index.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BilibiliClient } from './bilibili.mjs';
import { NeteaseClient } from './netease.mjs';
import { matchSong, searchCandidates, maxScoreFor } from './match.mjs';
import { detectLang, LANG_LABEL, buildQueries, needsBilingual } from './lang.mjs';
import { Cache } from './cache.mjs';
import { History } from './history.mjs';
import { mapLimit } from './http.mjs';
import { formatDuration, formatCount } from './text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = process.env.CACHE_DIR ?? path.join(ROOT, '.cache');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

const bili = new BilibiliClient({ debug: process.env.DEBUG_BILI === '1' });
const netease = new NeteaseClient();
const cache = new Cache({ dir: CACHE_DIR, ttlMs: Number(process.env.CACHE_TTL_MS ?? 12 * 3600 * 1000) });
const history = new History(process.env.HISTORY_DIR ?? path.join(CACHE_DIR, 'history'));

// ---------- 会话持久化，避免每次重启都重新握手 ----------
const SESSION_FILE = path.join(CACHE_DIR, 'bili-session.json');
try {
  if (fs.existsSync(SESSION_FILE)) bili.importSession(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
} catch {
  /* 会话文件损坏则忽略 */
}
function persistSession() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(bili.exportSession()), 'utf8');
  } catch {
    /* ignore */
  }
}

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 移动端 UA 特征——用来决定默认给桌面版还是手机版界面 */
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS/i;

/**
 * 静态资源。
 *
 * `/` 会按 User-Agent 自动选版本：手机给 index.html（单列、适合竖屏），
 * 桌面给 desktop.html（主从两栏、信息密度高）。
 * 也可以显式访问 `/desktop` 或 `/mobile` 强制指定。
 */
function serveStatic(req, res, urlPath) {
  let rel = urlPath;
  if (rel === '/' || rel === '') {
    rel = MOBILE_UA.test(req.headers['user-agent'] ?? '') ? '/index.html' : '/desktop.html';
  } else if (rel === '/desktop' || rel === '/desktop/') {
    rel = '/desktop.html';
  } else if (rel === '/mobile' || rel === '/mobile/') {
    rel = '/index.html';
  }

  let file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  // 允许省略 .html 后缀（/desktop 已特判，这里兜住任意页面名）
  if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    // 开发期避免改完页面还要手动硬刷新
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 输出给客户端的候选精简结构 */
function publicCandidate(c) {
  return {
    bvid: c.bvid,
    title: c.title,
    author: c.author,
    cover: c.cover,
    play: c.play,
    playText: formatCount(c.play),
    danmaku: c.danmaku,
    durationSec: c.durationSec,
    durationText: c.durationText || formatDuration(c.durationSec),
    pubdate: c.pubdate,
    typename: c.typename,
    tag: c.tag,
    description: c.description,
    url: c.url,
    appUrl: c.appUrl,
    score: c.score,
    confidence: c.confidence,
    bilingualHit: c.bilingualHit,
    mvHit: c.mvHit,
    nameHit: c.nameHit,
    // 注意：这里是逐字段显式白名单，漏一个字段就会被静默丢弃。
    // titleOnlyHit 曾被漏掉（App 的 types.ts 里有声明），
    // 现由 app/scripts/check-contract.mjs 这类契约测试兜住。
    titleOnlyHit: c.titleOnlyHit,
    negativeTags: c.negativeTags,
    breakdown: c.breakdown,
    reasons: c.reasons,
    sources: c.sources,
    multiPart: c.multiPart,
  };
}

function publicResult(r) {
  return {
    song: r.song,
    lang: r.lang,
    langLabel: LANG_LABEL[r.lang] ?? r.lang,
    langConfidence: r.langConfidence,
    bilingualNeeded: r.bilingualNeeded,
    confidence: r.confidence,
    best: r.best ? publicCandidate(r.best) : null,
    candidates: r.candidates.map(publicCandidate),
    meta: r.meta,
  };
}

/** 核心：批量匹配，逐首回调（用于 SSE 流式返回） */
async function runMatch(
  tracks,
  { limit = 20, offset = 0, enrich = false, lang, concurrency = 3, preferBilingual = true },
  onResult
) {
  const slice = tracks.slice(offset, offset + limit);
  const total = tracks.length;

  await mapLimit(slice, concurrency, async (song, i) => {
    const index = offset + i;

    // 补歌词：语种识别的可靠判据（日语必有假名、韩语必有谚文）。
    // 判错语种会直接导致用错的双语关键词，所以这一步值得一次额外请求。
    if (!song.lyric && !lang) {
      try {
        song.lyric = await cache.wrap(
          `lyric:v1:${song.id}`,
          () => netease.getLyric(song.id),
          7 * 24 * 3600 * 1000
        );
      } catch {
        song.lyric = '';
      }
    }

    const key = `match:v5:${song.id}:${lang ?? 'auto'}:${enrich ? 'e' : 'n'}:${preferBilingual ? 'b' : 'n'}:${song.title}:${song.artistText}:${song.durationSec}`;
    let result;
    try {
      result = await cache.wrap(
        key,
        () => matchSong(bili, song, { enrich, lang, topN: 6, preferBilingual }),
        24 * 3600 * 1000
      );
    } catch (e) {
      result = {
        song,
        lang: lang ?? 'other',
        langLabel: LANG_LABEL[lang ?? 'other'],
        bilingualNeeded: false,
        confidence: 'error',
        best: null,
        candidates: [],
        error: e?.message ?? String(e),
        meta: {},
      };
    }
    const pub = publicResult(result);
    pub.index = index;
    if (onResult) await onResult(pub);
    return pub;
  });
  void total;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  // 访问日志：自建服务最常见的求助就是「手机连不上后端」，
  // 有了这行就能立刻区分「请求根本没到」还是「到了但出错」。
  // 打印来源 IP，方便判断手机是否真的打到了这台机器。
  const __t0 = Date.now();
  if (p.startsWith('/api/')) {
    res.on('finish', () => {
      const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const q = url.search || '';
      console.log(
        `[api] ${(req.method ?? 'GET').padEnd(4)} ${p}${q.length > 60 ? `${q.slice(0, 60)}…` : q} ` +
          `→ ${res.statusCode} ${Date.now() - __t0}ms  from ${ip}`
      );
    });
  }

  try {
    // ---- 健康检查 ----
    if (p === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        service: 'bili-mv-finder',
        version: '1.0.0',
        bili: { ...bili.stats, sessionReady: bili.sessionReady, hasBuvid3: bili.jar.has('buvid3') },
        cache: cache.stats(),
        time: Date.now(),
      });
    }

    // ---- 语种识别（App 端展示/手动纠正用）----
    if (p === '/api/lang') {
      const song = {
        title: url.searchParams.get('title') ?? '',
        artists: (url.searchParams.get('artist') ?? '').split(/[/,、]/).map((s) => s.trim()).filter(Boolean),
        aliases: (url.searchParams.get('alias') ?? '').split(/[/|]/).map((s) => s.trim()).filter(Boolean),
      };
      // 传了 id 就取歌词来判定 —— 与正式匹配流程保持一致，
      // 否则「预览」和「匹配」会对同一首歌给出不同语种。
      const lyricId = url.searchParams.get('id');
      if (lyricId && /^\d+$/.test(lyricId)) {
        song.lyric = await cache.wrap(
          `lyric:v1:${lyricId}`,
          () => netease.getLyric(lyricId),
          7 * 24 * 3600 * 1000
        );
      }
      const d = detectLang(song);
      return sendJSON(res, 200, {
        ...d,
        label: LANG_LABEL[d.lang],
        needsBilingual: needsBilingual(d.lang),
        usedLyric: Boolean(song.lyric),
        queries: buildQueries(song, d.lang, { bilingualFirst: true }).map((q) => q.query),
      });
    }

    // ---- 歌单解析 ----
    if (p === '/api/playlist') {
      const input = url.searchParams.get('id') ?? url.searchParams.get('url') ?? '';
      const { id, resolvedFrom } = await netease.resolvePlaylistInput(input);
      const pl = await netease.getPlaylist(id);
      const summary = {
        ...pl,
        resolvedFrom: resolvedFrom ?? null,
        tracks: pl.tracks.map((t) => {
          const d = detectLang(t);
          return { ...t, lang: d.lang, langLabel: LANG_LABEL[d.lang], needsBilingual: needsBilingual(d.lang) };
        }),
      };
      return sendJSON(res, 200, summary);
    }

    // ---- 单曲候选（「换一个」/手动搜索）----
    if (p === '/api/search') {
      const title = url.searchParams.get('title') ?? '';
      if (!title) return sendJSON(res, 400, { error: '缺少 title 参数' });
      const artists = (url.searchParams.get('artist') ?? '').split(/[/,、]/).map((s) => s.trim()).filter(Boolean);
      const durationSec = Number(url.searchParams.get('duration')) || null;
      const lang = url.searchParams.get('lang') ?? undefined;
      const extraKeyword = url.searchParams.get('extra') ?? '';
      // 与匹配流程一致：关闭双语优先后，手动重搜也按热度/本家排序
      const preferBilingual = url.searchParams.get('preferBilingual') !== '0';
      const key = `search:v2:${title}:${artists.join(',')}:${durationSec}:${lang}:${extraKeyword}:${preferBilingual ? 'b' : 'n'}`;
      const r = await cache.wrap(key, () => searchCandidates(bili, { title, artists, durationSec, lang, extraKeyword, preferBilingual, topN: 14 }));
      return sendJSON(res, 200, {
        song: r.song,
        lang: r.lang,
        langLabel: LANG_LABEL[r.lang],
        best: r.best ? publicCandidate(r.best) : null,
        candidates: r.candidates.map(publicCandidate),
        maxScore: maxScoreFor(r.lang, preferBilingual),
      });
    }

    // ---- 视频详情 ----
    if (p === '/api/video') {
      const bvid = url.searchParams.get('bvid') ?? '';
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return sendJSON(res, 400, { error: 'bvid 格式不正确' });
      const d = await bili.viewVideo(bvid);
      if (!d) return sendJSON(res, 404, { error: '视频不存在或已下架' });
      return sendJSON(res, 200, d);
    }

    // ---- 批量匹配（SSE 流式，推荐）----
    if (p === '/api/match/stream') {
      const input = url.searchParams.get('id') ?? url.searchParams.get('url') ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 60);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const enrich = url.searchParams.get('enrich') === '1';
      // 外语歌是否优先双语字幕（App 端可切换；默认开启）
      const preferBilingual = url.searchParams.get('preferBilingual') !== '0';
      const lang = url.searchParams.get('lang') || undefined;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      const send = (type, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const t0 = Date.now();
      try {
        const { id, resolvedFrom } = await netease.resolvePlaylistInput(input);
        send('playlist_start', { id, resolvedFrom, limit, offset });
        const playlistCacheKey = `playlist:v1:${id}`;
        const pl = await cache.wrap(playlistCacheKey, () => netease.getPlaylist(id), 6 * 3600 * 1000);
        const plPublic = {
          id: pl.id,
          name: pl.name,
          cover: pl.cover,
          creator: pl.creator,
          trackCount: pl.trackCount,
          playCount: pl.playCount,
          description: pl.description,
          tracks: pl.tracks.map((t) => {
            const d = detectLang(t);
            return { ...t, lang: d.lang, langLabel: LANG_LABEL[d.lang], needsBilingual: needsBilingual(d.lang) };
          }),
        };
        history.recordPlaylist(plPublic, { preferBilingual, countView: offset === 0 });
        send('playlist', plPublic);

        const slice = pl.tracks.slice(offset, offset + limit);
        send('progress', { done: 0, total: slice.length, phase: 'matching' });

        let done = 0;
        const results = [];
        await runMatch(
          pl.tracks,
          { limit, offset, enrich, lang, preferBilingual, concurrency: Number(process.env.MATCH_CONCURRENCY ?? 3) },
          async (r) => {
            history.recordResult(pl.id, r);
            if (closed) return;
            results.push(r);
            done++;
            send('song', r);
            send('progress', { done, total: slice.length, phase: 'matching' });
          }
        );

        persistSession();
        history.flush(String(pl.id));
        if (!closed) {
          send('done', {
            elapsedMs: Date.now() - t0,
            count: results.length,
            offset,
            limit,
            hasMore: offset + limit < pl.tracks.length,
            nextOffset: offset + results.length,
            biliStats: bili.stats,
          });
        }
      } catch (e) {
        send('error', { message: e?.message ?? String(e) });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // ---- 批量匹配（一次性 JSON，适合小批量 / 调试）----
    if (p === '/api/match' || (p === '/api/match' && req.method === 'POST')) {
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const input = url.searchParams.get('id') ?? url.searchParams.get('url') ?? body.playlistId ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? body.limit) || 20, 60);
      const offset = Math.max(Number(url.searchParams.get('offset') ?? body.offset) || 0, 0);
      const enrich = url.searchParams.get('enrich') === '1' || body.enrich === true;
      const preferBilingual =
        url.searchParams.get('preferBilingual') !== '0' && body.preferBilingual !== false;
      const lang = url.searchParams.get('lang') ?? body.lang ?? undefined;

      let tracks = body.tracks;
      let playlistMeta = null;
      if (!Array.isArray(tracks) || !tracks.length) {
        const { id } = await netease.resolvePlaylistInput(input);
        const pl = await cache.wrap(`playlist:v1:${id}`, () => netease.getPlaylist(id), 6 * 3600 * 1000);
        tracks = pl.tracks;
        playlistMeta = { id: pl.id, name: pl.name, cover: pl.cover, creator: pl.creator, trackCount: pl.trackCount };
      }
      const results = [];
      await runMatch(tracks, { limit, offset, enrich, lang, preferBilingual, concurrency: Number(process.env.MATCH_CONCURRENCY ?? 3) }, async (r) => {
        results.push(r);
      });
      persistSession();
      return sendJSON(res, 200, {
        playlist: playlistMeta,
        offset,
        limit,
        total: tracks.length,
        results,
        biliStats: bili.stats,
      });
    }

    // ---- 缓存管理 ----
    if (p === '/api/cache/clear' && req.method === 'POST') {
      cache.clear();
      return sendJSON(res, 200, { ok: true, cache: cache.stats() });
    }

    // ---- 浏览历史 ----
    if (p === '/api/history') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 100);
      return sendJSON(res, 200, { items: history.list({ q: url.searchParams.get('q') ?? '', limit }) });
    }
    if (p === '/api/history/item') {
      const snap = history.open(url.searchParams.get('id') ?? '');
      if (!snap) return sendJSON(res, 404, { error: '历史记录不存在或已被删除' });
      return sendJSON(res, 200, snap);
    }
    if (p === '/api/history/delete' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: history.remove(url.searchParams.get('id') ?? '') });
    }
    if (p === '/api/history/clear' && req.method === 'POST') {
      history.clear();
      return sendJSON(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: `未知接口 ${p}` });

    // ---- 静态站点（内置 Web 预览页）----
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    return sendJSON(res, status, { error: e?.message ?? '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  const nets = Object.values(import.meta.url ? {} : {});
  void nets;
  console.log(`\n  🎬 寻影姬 BiliTune 服务已启动`);
  console.log(`     本机:   http://127.0.0.1:${PORT}`);
  console.log(`     局域网: http://<你的电脑IP>:${PORT}   ← 手机 App 填这个`);
  console.log(`     缓存:   ${CACHE_DIR}`);
  console.log(`     限流:   每 ${process.env.BILI_MIN_INTERVAL_MS ?? 250}ms 一次 B站 请求\n`);
  // 预热并校验整条检索链路（握手 → WBI 签名 → 真实搜索）。
  // 冷启动时首轮检索可能撞上风控而静默返回空，那样用户的第一次匹配
  // 就会"双语候选凭空消失"。把这个问题留在启动阶段暴露更好。
  bili
    .warmup()
    .then(() => persistSession())
    .catch(() => {});
});
