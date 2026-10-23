/** 调试：检查官方账号判断为何误命中 */
import { matchedOfficialName, buildOfficialSet, OFFICIAL_UP_PATTERN, compactName } from '../src/officialUps.mjs';

const set = buildOfficialSet();
const authors = [
  '那歌Music',
  'Official制作工作室',
  '时光唱片馆',
  '时光唱片行',
  '杰威尔音乐',
  '索尼音乐中国',
  '环球音乐中国',
  'WNS_WeNeedBTS',
  '姐夫日剧字幕组',
  '音乐私藏馆',
  '时光音乐阁',
  'Ayase-YOASOBI',
  'EdSheeran',
  'YG_FAMILY',
];

console.log('白名单条目数:', set.size);
console.log('');
for (const a of authors) {
  const hit = matchedOfficialName(a, set);
  const c = compactName(a);
  const inSet = [...set].filter((n) => c.includes(n));
  console.log(
    `${a.padEnd(24)} → ${hit ? `✅ 命中「${hit}」` : '❌ 未命中'}   compact=${c}  子串命中=${JSON.stringify(inSet)}`
  );
}

console.log('\n正则直接测试:');
for (const a of ['那歌Music', 'Official制作工作室', 'Taylor Swift Official', '官方号']) {
  const m = String(a).match(OFFICIAL_UP_PATTERN);
  console.log(`  ${a.padEnd(24)} → ${m ? `命中 "${m[0]}"` : '不命中'}`);
}
