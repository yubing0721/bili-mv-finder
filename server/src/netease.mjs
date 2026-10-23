/**
 * 网易云音乐歌单解析
 *
 * 支持多种输入：纯歌单 ID、网页链接、App 分享链接、163cn.tv 短链、整段分享文案。
 * 只使用公开的 web 接口，无需登录。
 */
import { fetchJSON, CookieJar, RateLimiter, HttpError, DEFAULT_UA } from './http.mjs';
import { clean } from './text.mjs';

const NET_BASE = 'https://music.163.com';
const NET_HEADERS = {
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  Accept: 'application/json, text/plain, */*',
};

export class NeteaseClient {
  constructor(opts = {}) {
    this.jar = new CookieJar({ appver: '8.9.70', os: 'pc', channel: 'netease', _ntes_nuid: String(Date.now()) });
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 150);
  }

  async api(path, params = {}) {
    const url = new URL(path, NET_BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return fetchJSON(url.toString(), {
      cookieJar: this.jar,
      limiter: this.limiter,
      headers: NET_HEADERS,
      retries: 2,
    });
  }

  /**
   * 从任意用户输入里解析出歌单 ID
   * @param {string} input
   * @returns {Promise<{id:string, raw:string, resolvedFrom?:string}>}
   */
  async resolvePlaylistInput(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new HttpError('请输入网易云歌单链接或 ID');

    // 直接的纯数字 ID
    if (/^\d{4,}$/.test(raw)) return { id: raw, raw };

    // 短链：需要跟随跳转
    const shortMatch = raw.match(/https?:\/\/[^\s"']*163cn\.tv\/[A-Za-z0-9]+/);
    if (shortMatch) {
      const finalUrl = await this.followRedirect(shortMatch[0]);
      const id = extractPlaylistId(finalUrl);
      if (id) return { id, raw, resolvedFrom: finalUrl };
      throw new HttpError(`短链跳转后未找到歌单 ID：${finalUrl}`);
    }

    const id = extractPlaylistId(raw);
    if (id) return { id, raw };
    if (/^\d{4,}$/.test(raw)) return { id: raw, raw };
    throw new HttpError('无法从输入中识别歌单 ID，请粘贴包含 "playlist?id=" 的链接');
  }

  /** 跟随重定向拿到最终 URL */
  async followRedirect(url) {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': DEFAULT_UA, ...NET_HEADERS },
      });
      const loc = res.headers.get('location');
      if (!loc) return res.url || url;
      url = new URL(loc, url).toString();
      const id = extractPlaylistId(url);
      if (id) return url;
    }
    return url;
  }

  /**
   * 获取歌单详情 + 全量曲目
   * @param {string} id
   */
  async getPlaylist(id) {
    const j = await this.api('/api/v6/playlist/detail', { id, n: 1000, s: 8 });
    if (j.code !== 200 || !j.playlist) {
      throw new HttpError(`歌单读取失败 (code=${j.code}${j.msg ? ` ${j.msg}` : ''})，请确认歌单为公开歌单`);
    }
    const pl = j.playlist;
    const seen = new Map();
    const push = (t) => {
      const s = normalizeTrack(t);
      if (s && !seen.has(s.id)) seen.set(s.id, s);
    };
    for (const t of pl.tracks ?? []) push(t);

    // 超过 1000 首或接口未返回完整 tracks 时，用 trackIds 补齐
    const ids = (pl.trackIds ?? []).map((x) => x.id).filter(Boolean);
    const missing = ids.filter((x) => !seen.has(String(x)));
    if (missing.length) {
      for (let i = 0; i < missing.length; i += 400) {
        const batch = missing.slice(i, i + 400);
        try {
          const d = await this.api('/api/song/detail', { ids: JSON.stringify(batch) });
          for (const t of d.songs ?? []) push(t);
        } catch {
          /* 单批失败不影响整体 */
        }
      }
    }

    // 保持 trackIds 的顺序
    const ordered = ids.length ? ids.map((x) => seen.get(String(x))).filter(Boolean) : [...seen.values()];

    return {
      id: String(pl.id),
      name: clean(pl.name),
      cover: pl.coverImgUrl ?? '',
      description: clean(pl.description ?? ''),
      creator: pl.creator?.nickname ? clean(pl.creator.nickname) : '',
      trackCount: pl.trackCount ?? ordered.length,
      playCount: pl.playCount ?? 0,
      updateTime: pl.updateTime ?? 0,
      tracks: ordered,
      url: `https://music.163.com/#/playlist?id=${pl.id}`,
    };
  }

  /** 单曲检索：用于 App 里「手动搜索某首歌」 */
  async searchSong(keyword, limit = 10) {
    const j = await this.api('/api/search/get', { s: keyword, type: 1, limit, offset: 0 });
    const list = j?.result?.songs ?? [];
    return list.map((s) => normalizeTrack(s)).filter(Boolean);
  }

  /**
   * 获取歌词原文。
   *
   * 为什么要歌词：语种识别的可靠判据。
   * 「米津玄師 - Lemon」和「林俊杰 - Always Online」光看歌名歌手几乎无法区分，
   * 但歌词里日语必然有大量假名、韩语必然有大量谚文，一验就准。
   * 语种判错会直接导致用错的双语关键词（中日 ↔ 中英），所以这一步值得多花一次请求。
   *
   * @param {string|number} songId
   * @returns {Promise<string>} 歌词原文，取不到则返回空串
   */
  async getLyric(songId) {
    try {
      const j = await this.api('/api/song/lyric', { id: songId, lv: 1, kv: 1, tv: -1 });
      return j?.lrc?.lyric ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 给一批歌曲补上歌词（并发受限，失败静默忽略）
   * @param {object[]} tracks
   * @param {number} concurrency
   */
  async attachLyrics(tracks, concurrency = 4) {
    const { mapLimit } = await import('./http.mjs');
    await mapLimit(tracks, concurrency, async (t) => {
      if (t.lyric) return;
      t.lyric = await this.getLyric(t.id);
    });
    return tracks;
  }
}

/** 从文本中提取歌单 ID */
export function extractPlaylistId(text) {
  if (!text) return null;
  // playlist?id=123 / playlist/123 / #/playlist?id=123
  let m = String(text).match(/playlist[/?#]*(?:.*?[?&])?id=(\d{4,})/i);
  if (m) return m[1];
  m = String(text).match(/playlist\/(\d{4,})/i);
  if (m) return m[1];
  m = String(text).match(/[?&]id=(\d{4,})/);
  if (m) return m[1];
  m = String(text).match(/\b(\d{5,})\b/);
  if (m) return m[1];
  return null;
}

/** 把网易云的 track 结构统一成内部 Song 结构 */
export function normalizeTrack(t) {
  if (!t || !t.id) return null;
  const rawArtists = t.ar ?? t.artists ?? [];
  const artists = rawArtists.map((a) => clean(a.name)).filter(Boolean);
  // 歌手别名（如 Aimer → エメ、周杰伦 → Jay Chou），对 B站 检索与命中判断都很有用
  const artistAliases = rawArtists.flatMap((a) => (a.alias ?? []).map(clean)).filter(Boolean);
  const album = t.al ?? t.album ?? {};
  const aliases = [...(t.alia ?? []), ...(t.tns ?? [])].map(clean).filter(Boolean);
  return {
    id: String(t.id),
    title: clean(t.name),
    subtitle: t.alia?.[0] ? clean(t.alia[0]) : '',
    aliases,
    artists,
    artistAliases,
    artistText: artists.join(' / '),
    album: album.name ? clean(album.name) : '',
    cover: album.picUrl ?? '',
    /** 网易云给的是毫秒 */
    durationSec: t.dt ? Math.round(t.dt / 1000) : t.duration ? Math.round(t.duration / 1000) : null,
    fee: t.fee ?? null,
    noCopyright: t.noCopyrightRcmd != null || t.st === -200,
    url: `https://music.163.com/#/song?id=${t.id}`,
  };
}

export const netease = new NeteaseClient();
