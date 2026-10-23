/**
 * 驱动桌面应用并截图（一体化脚本，避免 PowerShell 内联引号地狱）
 *
 * 用法：
 *   node scripts/capture.mjs --port=9228 --id=71385702 --out=screenshots/x.png --wait=10
 *
 * 不传 --id 就只截当前窗口状态。
 */
import fs from 'node:fs';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const PORT = Number(arg('port', 9222));
const ID = arg('id', '');
const OUT = arg('out', 'screenshot.png');
const WAIT = Number(arg('wait', 10));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) {
  console.error('✖ 没找到页面 target');
  process.exit(1);
}
console.log(`  页面: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.rej(new Error(msg.error.message)) : slot.res(msg.result);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const m = ++id;
    pending.set(m, { res, rej });
    ws.send(JSON.stringify({ id: m, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'JS 异常');
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (ID) {
  await js(`document.getElementById('input').value = ${JSON.stringify(ID)}`);
  await js(`document.getElementById('go').click()`);
  console.log(`  已发起匹配（歌单 ${ID}），等待结果…`);
  let n = 0;
  for (let i = 0; i < 140; i++) {
    n = await js(`document.querySelectorAll('.song .m').length`);
    if (n >= WAIT) break;
    await sleep(1500);
  }
  const stat = await js(`document.querySelector('footer').innerText.replace(/\\n/g,'  ')`);
  console.log(`  已渲染 ${n} 条结果`);
  console.log(`  底栏: ${stat}`);
}

// 选中一条「有双语」的，让截图更有信息量
await js(`
  (() => {
    const bi = [...document.querySelectorAll('.song')].find(r => r.querySelector('.m.bi'));
    if (bi) bi.click();
  })()
`);
await sleep(1200);

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
console.log(`✓ 已保存 ${OUT}（${Math.round(fs.statSync(OUT).size / 1024)} KB）`);
ws.close();
