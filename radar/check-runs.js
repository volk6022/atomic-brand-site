// Поведенческая проверка экрана «Runs» — блок В из _TESTS-autoflow-gui.md
// (G-10…G-13), стенд по образцу check-backfill.js.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики.
// Ни тот, ни другой не нажимает на чипсы и не сверяет, ЧТО уехало на сервер.
// Здесь файл исполняет настоящую логику экрана под записывающим API и сверяет,
// ЧТО экран запросил и ЧТО нарисовал. Это контракт: правится экран, а не файл.
//
//   node check-runs.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarRuns.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const RUNS = fixtures['/runs'];
if (!RUNS || !Array.isArray(RUNS.rows) || !RUNS.rows.length) {
  console.error('нет образца GET /runs со строками. Снимем прогоном dump_gui_fixtures или пополни api-fixtures.json');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], post: [], toasts: []};
  const api = {
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      if (p === '/runs') return clone(opts.list || RUNS);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p) => {
      calls.post.push({p: p});
      return {ok: true};
    },
    describe: (e) => (e && e.message) ? String(e.message) : String(e),
    isUnauthorized: () => false,
    isForbidden: () => false,
  };

  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, RegExp,
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    window: {addEventListener() {}, removeEventListener() {}, open() {}},
    __imp: async (p) => (p.indexOf('radar-table') >= 0 ? {Table: ctx.__Table} : api),
  };
  vm.createContext(ctx);
  vm.runInContext(tableSrc + '\n;this.__Table = Table;', ctx);

  // Событийного канала в стенде нет: экран живёт запасным путём (опрос),
  // а подписки на `events` просто не случаются — как в оболочке без потока.
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast:(t, c)=>__calls.toasts.push({t: t, c: c}), drill(){}, trace(){},
              go(){}, modal(){}}, mobile:false}, {}); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__calls = calls;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const runsGets = (calls) => calls.get.filter((g) => g.p === '/runs');
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {
  // 0. До загрузки экран обязан отдавать все дырки разметки, включая новые
  //    (authorChips): отсутствующий ключ не падает, а молча оставляет пустоту.
  {
    const {c} = build();
    const v = vals(c);
    check('renderVals() до загрузки не падает', !v.__err);
    check('до загрузки ключи разметки присутствуют (включая authorChips)',
          ['rows', 'cols', 'pages', 'kinds', 'scopes', 'authorChips', 'range',
           'pendingLabel', 'liveLabel', 'hint'].every((k) => k in v));
  }

  // G-10. Строка человека — без метки. rows[0] фикстуры запущен владельцем
  //       (owner@local): метки «авто» нет, автор виден как есть.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-10 строка человека: who = owner@local дословно из created_by',
          !!v.rows[0] && v.rows[0].who === 'owner@local');
    check('G-10 строка человека: метки «авто» нет', !!v.rows[0] && v.rows[0].auto === false);
    check('порядок строк — порядок ответа сервера (экран не перемешивает)',
          v.rows.map((r) => r.who).join(',') === RUNS.rows.map((r) => r.created_by).join(','));
  }

  // G-11. Авто-строка подсвечена. Копия фикстуры с created_by:'auto:tick':
  //       метка «авто» цвета #C98A1E стоит рядом, но АВТОР не прячется —
  //       кто именно запустил (auto:tick, auto:reclassify…) — это данные.
  {
    const autoTick = clone(RUNS);
    autoTick.rows[0].created_by = 'auto:tick';
    const {c} = build({list: autoTick});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-11 авто-строка: метка «авто» стоит', !!v.rows[0] && v.rows[0].auto === true);
    check('G-11 авто-строка: текст метки «авто»', !!v.rows[0] && v.rows[0].autoLabel === 'авто');
    check('G-11 авто-строка: цвет метки #C98A1E', !!v.rows[0] && v.rows[0].autoFg === '#C98A1E');
    check('G-11 авто-строка: who показывает auto:tick целиком (автор не спрятан)',
          !!v.rows[0] && v.rows[0].who === 'auto:tick');
    // Авто-строка из самого снимка (auto:reclassify) подсвечена тем же путём.
    const own = build();
    await own.c.componentDidMount();
    await sleep();
    const ownVals = vals(own.c);
    const idx = RUNS.rows.findIndex((r) => String(r.created_by || '').indexOf('auto:') === 0);
    check('G-11 строка auto:reclassify из фикстуры подсвечена так же',
          idx >= 0 && !!ownVals.rows[idx] && ownVals.rows[idx].auto === true);
  }

  // G-12. Чипс «авто» шлёт author=auto, «все» убирает параметр вовсе.
  //       Пустое значение фильтра не должно превращаться в author= на сервере.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    check('G-12 первый запрос (все) — параметра author нет',
          !!runsGets(calls)[0] && !('author' in runsGets(calls)[0].q));

    let v = vals(c);
    const autoChip = v.authorChips.find((a) => a.label === 'авто');
    const allChip = v.authorChips.find((a) => a.label === 'все');
    check('G-12 чипсов ровно два: «все» и «авто» (ревью §8-2 — без «мои»)',
          v.authorChips.length === 2 && !!autoChip && !!allChip);
    check('G-12 до выбора активен чипс «все»',
          !!allChip && allChip.bg === '#131E5F');

    if (autoChip) { autoChip.pick(); await sleep(); }
    const second = runsGets(calls)[1];
    check('G-12 клик «авто» → GET /runs с q.author = "auto"',
          !!second && second.q.author === 'auto');

    v = vals(c);
    const autoAfter = v.authorChips.find((a) => a.label === 'авто');
    check('G-12 после выбора активен чипс «авто»',
          !!autoAfter && autoAfter.bg === '#131E5F' && autoAfter.fg === '#F8F3E0');

    const allAfter = v.authorChips.find((a) => a.label === 'все');
    if (allAfter) { allAfter.pick(); await sleep(); }
    const third = runsGets(calls)[2];
    check('G-12 клик «все» → параметр author из запроса исчез',
          !!third && !('author' in third.q));
  }

  // G-13. Чужое не тронуто: счётчик недосчитанного, словарь статусов с
  //       cancelled (у прогонов — словарь прогонов, не очереди), фильтр
  //       доступности kinds — всё дословно из фикстуры /runs.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-13 подпись недосчитанного — из pending_messages фикстуры (' +
          RUNS.pending_messages + ')',
          v.pendingLabel === 'ждёт обработки сообщений: ' + RUNS.pending_messages);
    check('G-13 словарь статусов говорит cancelled, не canceled',
          c.STATUS_LABEL.cancelled === 'остановлена' && !('canceled' in c.STATUS_LABEL) &&
          !('canceled' in c.STATUS_COLOR));
    check('G-13 статусы строк — словарём экрана, не сырым кодом сервера',
          v.rows[0].status === c.STATUS_LABEL[RUNS.rows[0].status] &&
          v.rows[1].status === c.STATUS_LABEL[RUNS.rows[1].status]);

    // kinds: экран показывает доступные («available») и те, что запускаются
    // в Channels, с припиской; недоступные нигде («Выгрузка») не показывает.
    const expected = RUNS.kinds.filter((k) => k.available || k.where === 'channels');
    check('G-13 kinds-фильтр: показано ровно доступных + канальных (' +
          expected.length + ' из ' + RUNS.kinds.length + ')',
          v.kinds.length === expected.length);
    check('G-13 kinds-фильтр: доступный вид назван дословно из фикстуры',
          !!v.kinds[0] && v.kinds[0].label ===
            RUNS.kinds.find((k) => k.available && k.where === 'runs').title);
    check('G-13 kinds-фильтр: недоступный нигде вид спрятан',
          !v.kinds.some((k) => k.label.indexOf(
            RUNS.kinds.find((k2) => k2.where === 'nowhere').title) === 0));
  }

  // 14.8.9/14.8.22. Поле поиска не теряет символы: setQ обязан синхронно
  // перерисовать экран (setState в том же событии input), чтобы renderVals().q
  // равнялся набранному ещё до истечения паузы 350 мс; запрос при этом не
  // уходит. Без синхронной перерисовки React — поле контролируемое
  // (value={{q}}) — откатывает введённую букву к пропу с прошлого рендера.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    let redraws = 0;
    const origSet = c.setState.bind(c);
    c.setState = (p, cb) => { redraws++; return origSet(p, cb); };
    const before = calls.get.length;
    vals(c).setQ({target: {value: 'Радар'}});
    // Всё ниже — синхронно, до всякой паузы: порядок событий и есть проверка.
    check('поиск: setQ перерисовывает экран синхронно (14.8.9/14.8.22)', redraws > 0);
    check('поиск: renderVals().q равен набранному до истечения паузы',
          vals(c).q === 'Радар');
    check('поиск: во время набора запрос не уходит', calls.get.length === before);
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
