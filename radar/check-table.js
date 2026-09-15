// Поведенческая проверка модуля radar-table.js — 14.8.22/14.8.9 (шаг 5, поля
// ввода теряют символы). Экраны вызывают `attach(reload, redraw)`, и `setQ`
// обязан СИНХРОННО (в том же событии `input`, до любого таймера) перерисовать
// экран: поле — контролируемое (`value={{q}}`), и React без синхронной
// перерисовки откатывает DOM-значение к пропу `value` с последнего рендера.
// Пока набор быстрее паузы 350 мс, это означает «Радар» → «р». Здесь модуль
// исполняется по-настоящему под vm, таймеры — ручные: проверка сама решает,
// когда «истекла» пауза, поэтому она не дребезжит от скорости машины.
//
//   node check-table.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const TABLE_SRC = fs.readFileSync(DIR + '/radar-table.js', 'utf8')
  .replace(/^export /gm, '');

// ── стенд ─────────────────────────────────────────────────────────────────────

// Ручные таймеры: срабатывание — только явным fireAll(). Реальный setTimeout
// сделал бы проверку зависимой от скорости набора/машины, а она про порядок
// вызовов, а не про миллисекунды.
function makeCtx() {
  const timers = [];
  let nextId = 0;
  const ctx = {
    console, URLSearchParams, Date, Math, JSON, RegExp,
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: (a, b, url) => { ctx.location.hash = String(url || ''); }},
    setTimeout: (fn, ms) => { const id = ++nextId; timers.push({id: id, fn: fn, ms: ms}); return id; },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  // «Пауза набора истекла»: срабатывают все живые таймеры (их максимум один —
  // каждый новый ввод снимает предыдущий).
  ctx.__fireAll = () => { const due = timers.splice(0, timers.length); for (const t of due) t.fn(); };
  ctx.__pendingTimers = timers;
  return ctx;
}

// Собирает Table из переданного исходника (настоящий или мутировавший) и
// присоединяет записывающие reload/redraw.
function makeTable(src, counters) {
  const ctx = makeCtx();
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.__Table = Table;', ctx);
  const T = new ctx.__Table({
    key: 'check', size: 25, sort: 'created', order: 'desc',
    sorts: [{key: 'created'}], filters: {state: ''},
  });
  T.attach(
    () => { counters.reloads++; },
    () => { counters.redraws++; });
  return {T: T, ctx: ctx};
}

// ── (а) контракт setQ ─────────────────────────────────────────────────────────

function contractSetQ(src) {
  const counters = {reloads: 0, redraws: 0};
  const {T, ctx} = makeTable(src, counters);

  // Человек стоит на второй странице и набирает.
  T.set({page: 2}, {resetPage: false});
  const reloadsAtStart = counters.reloads;   // переход страницы сам зовёт reload
  const before = T.vals(0);
  before.setQ({target: {value: 'Радар'}});
  // Никаких await между setQ и этими тремя утверждениями — это и есть
  // «синхронно, до любого таймера».
  const sync = [
    ['setQ зовёт redraw синхронно, в том же событии (до таймера)', counters.redraws === 1],
    ['vals().q === «Радар» сразу после setQ', T.vals(0).q === 'Радар'],
    ['до истечения паузы reload не зовётся', counters.reloads === reloadsAtStart],
  ];
  ctx.__fireAll();
  return sync.concat([
    ['после паузы reload зовётся ровно один раз', counters.reloads === reloadsAtStart + 1],
    ['запрос после паузы несёт q=«Радар»', T.query().q === 'Радар'],
    ['поиск возвращает на первую страницу (page = 1)', T.page === 1],
  ]);
}

async function main() {
  // (а) Контракт setQ при новой сигнатуре attach(reload, redraw).
  for (const [name, cond] of contractSetQ(TABLE_SRC)) check('(а) ' + name, cond);

  // (б) Быстрый набор: «Р», «Ра», «Рад», «Рада», «Радар» с интервалом меньше
  //     паузы. Каждая буква — синхронный redraw и свежее значение в vals();
  //     запрос — один, со всей строкой; повторный прогон таймеров ничего не
  //     добавляет (предыдущие сняты).
  {
    const counters = {reloads: 0, redraws: 0};
    const {T, ctx} = makeTable(TABLE_SRC, counters);
    const parts = ['Р', 'Ра', 'Рад', 'Рада', 'Радар'];
    let cumulative = true;
    for (const part of parts) {
      T.vals(0).setQ({target: {value: part}});
      if (T.vals(0).q !== part) cumulative = false;
    }
    check('(б) быстрый набор: redraw на каждую букву — 5', counters.redraws === 5);
    check('(б) быстрый набор: после каждой буквы vals().q равен набранному', cumulative);
    check('(б) быстрый набор: до паузы reload не звался', counters.reloads === 0);
    ctx.__fireAll();
    check('(б) быстрый набор: reload один', counters.reloads === 1);
    check('(б) быстрый набор: запрос с полной строкой q=«Радар»', T.query().q === 'Радар');
    ctx.__fireAll();
    check('(б) старые таймеры сняты: второй прогон не перезапрашивает', counters.reloads === 1);
  }

  // (в) Старая сигнатура attach(reload) без redraw не падает: перерисовки нет,
  //     но значение копится и запрос уходит один.
  {
    const counters = {reloads: 0, redraws: 0};
    const ctx = makeCtx();
    vm.createContext(ctx);
    vm.runInContext(TABLE_SRC + '\n;this.__Table = Table;', ctx);
    const T = new ctx.__Table({key: 'check', size: 25});
    let threw = null;
    try {
      T.attach(() => { counters.reloads++; });
      T.vals(0).setQ({target: {value: 'Радар'}});
    } catch (e) { threw = e; }
    check('(в) attach(reload) без redraw: setQ не падает', !threw);
    check('(в) attach(reload) без redraw: значение всё равно в vals().q',
          T.vals(0).q === 'Радар');
    ctx.__fireAll();
    check('(в) attach(reload) без redraw: reload после паузы — один',
          counters.reloads === 1 && T.query().q === 'Радар');
  }

  // (г) Сброс: q пуст, перезапрос сразу (без паузы).
  {
    const counters = {reloads: 0, redraws: 0};
    const {T, ctx} = makeTable(TABLE_SRC, counters);
    T.vals(0).setQ({target: {value: 'Радар'}});
    ctx.__fireAll();
    const before = counters.reloads;
    T.vals(0).resetAll();
    check('(г) reset(): q пуст', T.q === '' && T.vals(0).q === '');
    check('(г) reset(): строка поиска в запрос не попадает', !('q' in T.query()));
    check('(г) reset(): reload зван сразу, без паузы', counters.reloads === before + 1);
    check('(г) reset(): таймер набора снят', ctx.__pendingTimers.length === 0);
  }

  // (д) Мутация: убрать вызов redraw из setQ — проверка (а) обязана покраснеть.
  //     Иначе «оптимизация» обратно проходит незамеченной.
  {
    const callRe = /this\.redraw\(\)/g;
    const calls = (TABLE_SRC.match(callRe) || []).length;
    check('(д) в модуле ровно один вызов this.redraw() — в setQ', calls === 1);
    const mutant = TABLE_SRC.replace('this.setQuery(e.target.value); this.redraw();',
                                     'this.setQuery(e.target.value);');
    check('(д) мутация применилась (вызов убран)',
          mutant !== TABLE_SRC && !(mutant.match(callRe) || []).length);
    const mutantRed = contractSetQ(mutant).some(([, cond]) => !cond);
    check('(д) мутация «без redraw» красит проверку (а)', mutantRed);
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
