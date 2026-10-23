/** 诊断：直接看 B站 原始响应，弄清为什么某些查询返回 0 条 */
import { BilibiliClient } from '../src/bilibili.mjs';
import { fetchJSON } from '../src/http.mjs';
import { encWbi } from '../src/bilibili.mjs';

const b = new BilibiliClient({ debug: false });
await b.ensureSession();

// 直接复用客户端内部状态，绕过规范化，看原始结构
async function raw(keyword) {
  const params = { search_type: 'video', keyword, page: 1, page_size: 5, order: 'totalrank' };
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${encWbi(params, b.wbi.imgKey, b.wbi.subKey)}`;
  const j = await fetchJSON(url, {
    cookieJar: b.jar,
    limiter: b.limiter,
    headers: { Referer: 'https://search.bilibili.com/' },
  });
  const list = j?.data?.result ?? [];
  const types = {};
  for (const v of list) types[v.type] = (types[v.type] ?? 0) + 1;
  console.log(`\n查询 "${keyword}"  code=${j.code} message=${j.message ?? '-'}`);
  console.log(`  data 顶层字段: ${Object.keys(j.data ?? {}).join(', ')}`);
  console.log(`  numResults=${j.data?.numResults} numPages=${j.data?.numPages} result 长度=${list.length}`);
  console.log(`  result 里的 type 分布: ${JSON.stringify(types)}`);
  if (list[0]) console.log(`  首条: type=${list[0].type} title=${String(list[0].title).slice(0, 50)}`);
  return j;
}

await raw('周杰伦');
await raw('周杰伦 晴天');
await raw('晴天 周杰伦 MV');
await raw('陈奕迅');
await raw('Adele');
