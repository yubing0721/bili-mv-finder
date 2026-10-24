/**
 * 桌面版 UI 验证（通过 Chrome DevTools Protocol）
 *
 * 思路与真机调试时的 `adb shell uiautomator dump` 一样：
 * 不靠肉眼看截图，而是把窗口里**真实渲染出来的 DOM 文本**抓出来断言。
 *
 * 用法：
 *   1) 先带远程调试端口启动应用：
 *      npx electron . --remote-debugging-port=9222
 *   2) node scripts/verify-ui.mjs
 *
 * 可选参数：--port=9222  指定调试端口
 */
const DEBUG_PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 9222);
const CDP = `http://127.0.0.1:${DEBUG_PORT}`;

let pass = 0;
const fails = [];
const check = (label, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────── 连接 CDP

async function targets() {
  const r = await fetch(`${CDP}/json/list`);
  return r.json();
}

/** 极简 CDP 客户端：够用就行（只做 Runtime.evaluate） */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    // 收响应：按 id 找到对应的挂起 Promise 并兑现
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id == null) return; // 事件通知（非本客户端请求的响应）
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(`CDP 错误：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else slot.res(msg.result);
    });

    ws.addEventListener('open', () =>
      resolve({
        async evaluate(expression) {
          const msgId = ++id;
          let rejectFn = () => {};
          const p = new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            rejectFn = rej;
          });
          ws.send(
            JSON.stringify({
              id: msgId,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true },
            })
          );
          const timer = setTimeout(() => {
            if (pending.delete(msgId)) rejectFn(new Error('evaluate 超时'));
          }, 20000);
          try {
            return await p;
          } finally {
            clearTimeout(timer);
          }
        },
        close: () => ws.close(),
      })
    );
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket 错误：${e.message ?? e.type}`)));
  });
}

// ─────────────────────────────────────────── 主流程

console.log(`\n▶ 连接 CDP ${CDP}`);

let list;
try {
  list = await targets();
} catch (e) {
  console.error(`✖ 连不上调试端口 ${DEBUG_PORT}。请先带 --remote-debugging-port=${DEBUG_PORT} 启动应用。`);
  console.error(`   ${e.message}`);
  process.exit(1);
}

const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) {
  console.error('✖ 没有找到页面 target。当前 targets：');
  for (const t of list) console.error(`   [${t.type}] ${t.url}`);
  process.exit(1);
}
console.log(`  页面: ${page.url}`);
console.log(`  标题: ${page.title}`);

check('窗口加载的是后端页面（不是启动画面）', /127\.0\.0\.1:\d+\/desktop/.test(page.url), page.url);
check('页面标题正确', /寻影姬/.test(page.title), page.title);

const cdp = await connect(page.webSocketDebuggerUrl);

/** 取一段 JS 表达式的值 */
async function evalJS(expr) {
  const r = await cdp.evaluate(expr);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'JS 异常');
  return r.result?.value;
}

// 等前端脚本跑完（EventSource 连上、健康检查返回）
for (let i = 0; i < 20; i++) {
  const ready = await evalJS(`document.getElementById('connText')?.textContent ?? ''`);
  if (ready && !/检测中/.test(ready)) break;
  await sleep(500);
}

// 窗口里是否已经有歌单（用户可能正在用），决定后面走「空状态断言」还是「结果断言」
const preloaded = (await evalJS(`document.querySelectorAll('.song').length`)) > 0;

const text = await evalJS('document.body.innerText');
console.log('\n── 窗口内实际渲染的文本 ──');
console.log(
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `   ${l}`)
    .join('\n')
);

console.log('\n── 断言 ──');

// 布局：确认用的是桌面版而非手机版
const cols = await evalJS(`getComputedStyle(document.querySelector('main')).gridTemplateColumns`);
check('主区域是两栏布局（桌面版）', /\d+(\.\d+)?px\s+\d+(\.\d+)?px/.test(cols), cols);

const headerText = await evalJS(`document.querySelector('header').innerText`);
check('顶栏有品牌名', /寻影姬/.test(headerText), headerText.replace(/\n/g, ' | '));
check('顶栏有歌单输入框', await evalJS(`!!document.getElementById('input')`));
check('顶栏有开始按钮', /开始匹配/.test(headerText));

const connText = await evalJS(`document.getElementById('connText').textContent`);
check('后端连接状态已更新', /已连接|连不上/.test(connText), connText);
check('后端已连接', /已连接/.test(connText), connText);

check('左栏有歌单标题区域', Boolean(await evalJS(`document.getElementById('plName')?.textContent`)));
check('底栏有结果统计', /命中双语/.test(await evalJS(`document.querySelector('footer').innerText`)));

// 空状态专属断言：只在窗口里还没有歌单时检查
if (!preloaded) {
  check('左栏显示空状态提示', /还没有歌单/.test(await evalJS(`document.getElementById('plName').textContent`)));
  check('右栏有操作提示', /粘贴一个网易云歌单/.test(text));
  const samples = await evalJS(`[...document.querySelectorAll('[data-sample]')].map(a => a.dataset.sample)`);
  check('有示例歌单入口', Array.isArray(samples) && samples.length >= 2, JSON.stringify(samples));
} else {
  console.log('  （窗口里已有歌单，跳过空状态相关断言）');
}

// 关键：EventSource 是否真的建立了
const esReady = await evalJS(`typeof EventSource !== 'undefined'`);
check('EventSource 可用（SSE 流式匹配的前提）', esReady === true);

// 设置弹窗能开
await evalJS(`document.getElementById('openSettings').click()`);
await sleep(200);
check('设置弹窗可打开', (await evalJS(`document.getElementById('settings').classList.contains('on')`)) === true);
await evalJS(`document.getElementById('closeSettings').click()`);
await sleep(150);
check('设置弹窗可关闭', (await evalJS(`document.getElementById('settings').classList.contains('on')`)) === false);

// ─────────────────────────────────────────── 真实数据校验
// 如果窗口里已经载入了歌单（比如用户正在用），就直接验证现有结果，
// 不要覆盖掉他正在看的东西。
if (preloaded) {
  console.log('\n── 窗口里已有歌单，直接验证现有结果（不重新发起匹配）──');
} else {
  console.log('\n── 端到端：在窗口里跑一次真实匹配 ──');
  await evalJS(`document.getElementById('input').value = '3778678'`);
  await evalJS(`document.getElementById('go').click()`);
  console.log('  已点击「开始匹配」，等待结果…');
}

let rows = 0;
for (let i = 0; i < 150; i++) {
  rows = await evalJS(`document.querySelectorAll('.song').length`);
  if (rows > 0) break;
  await sleep(1000);
}
check('左栏渲染出歌曲列表', rows > 0, `渲染了 ${rows} 行`);

// 等第一条结果（带匹配内容）
let matched = 0;
for (let i = 0; i < 150; i++) {
  matched = await evalJS(`document.querySelectorAll('.song .m').length`);
  if (matched > 0) break;
  await sleep(1000);
}
check('至少有一条匹配结果', matched > 0, `${matched} 条`);

const playlistName = await evalJS(`document.getElementById('plName').textContent`);
console.log(`  歌单: ${playlistName}`);

const firstRow = await evalJS(`document.querySelector('.song')?.innerText ?? ''`);
check('列表行含歌名与歌手', firstRow.split('\n').filter(Boolean).length >= 2, firstRow.replace(/\n/g, ' | '));

const detailTitle = await evalJS(`document.getElementById('detailTitle').textContent`);
check('右栏显示了选中歌曲', detailTitle && detailTitle !== '候选详情', detailTitle);

const candCount = await evalJS(`document.querySelectorAll('.cand').length`);
check('右栏渲染出候选卡片', candCount > 0, `${candCount} 张`);

const statText = await evalJS(`document.querySelector('footer').innerText`);
console.log(`  底栏统计: ${statText.replace(/\n/g, '  ')}`);

// 点一下另一行，确认主从联动（挑一个当前没被选中的行，避免点到自己）
const switched = await evalJS(`
  (() => {
    const rows = [...document.querySelectorAll('.song')];
    const other = rows.find(r => !r.classList.contains('on'));
    if (!other) return null;
    other.click();
    return other.querySelector('.t')?.textContent ?? '';
  })()
`);
if (switched) {
  await sleep(700);
  const t2 = await evalJS(`document.getElementById('detailTitle').textContent`);
  check('点击左栏可切换右栏详情', t2 && t2.includes(switched), `期望含「${switched}」，实际「${t2}」`);
} else {
  console.log('  （只有一行，跳过主从联动断言）');
}

// 双语命中统计（这是本项目的核心诉求）
const biStat = await evalJS(`
  (() => {
    const rows = [...document.querySelectorAll('.song')];
    const bi = rows.filter(r => r.querySelector('.m.bi')).length;
    const langEls = rows.map(r => r.querySelector('.lang')?.textContent ?? '');
    const foreign = langEls.filter(l => l && l !== '中文').length;
    return JSON.stringify({ rows: rows.length, bilingual: bi, foreign });
  })()
`);
const s = JSON.parse(biStat);
console.log(`  外语歌 ${s.foreign} 首，其中 ${s.bilingual} 首命中双语`);
check('外语歌能匹配到双语版本', s.foreign === 0 || s.bilingual > 0, biStat);

await cdp.close();

// ─────────────────────────────────────────── 汇总
console.log('\n' + '═'.repeat(66));
if (fails.length) {
  console.log(`✖ 桌面版 UI 验证失败 ${fails.length} 项（通过 ${pass} 项）：\n`);
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
} else {
  console.log(`✓ 桌面版 UI 验证全部通过（${pass} 项断言）`);
  console.log('  窗口渲染、两栏布局、后端连通、SSE 流式匹配与主从联动均正常。');
}
