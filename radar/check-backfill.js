// Поведенческая проверка экрана очереди дочитывания.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики.
// Ни тот, ни другой не нажимает на кнопки и не сверяет ЧИСЛА. Для очереди это
// главный риск: если на экране не тот порядок или не те счётчики, «следующий
// канал» на экране и «следующий канал» в работе — разные каналы, а чипс с нулём
// вместо «отменено: 0» читается как «состояния не существует».
//
// Здесь файл исполняет настоящую логику экрана под записывающим API и сверяет,
// ЧТО экран запросил, ЧТО нарисовал и КОГДА перечитал. Это контракт: правится
// экран, а не файл.
//
//   node check-backfill.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarBackfill.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const LIST = fixtures['/backfill/queue'];
const REMOVE_ACK = fixtures['DELETE /backfill/queue/{id}'];
if (!LIST || !Array.isArray(LIST.items) || LIST.items.length < 4) {
  console.error('нет образца GET /backfill/queue минимум с 4 элементами. Снимем прогоном dump_gui_fixtures или пополни api-fixtures.json');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], del: [], toasts: []};
  const api = {
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      if (p === '/backfill/queue') return clone(opts.list || LIST);
      throw new Error('нет образца ответа для ' + p);
    },
    del: async (p) => {
      calls.del.push({p: p});
      if (opts.failRemove) throw new Error('работа уже взята воркером, снимать поздно');
      return clone(REMOVE_ACK);
    },
    post: async () => ({ok: true}),
    patch: async () => ({ok: true}),
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
const queueGets = (calls) => calls.get.filter((g) => g.p === '/backfill/queue');
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {
  const STATES = ['queued', 'running', 'done', 'failed', 'canceled'];

  // 1. До загрузки экран обязан отдавать все дырки разметки — и НЕ показывать
  //    пустое состояние: «загружаю» и «пусто» — разные новости.
  {
    const {c} = build();
    const v = vals(c);
    check('renderVals() до загрузки не падает', !v.__err);
    check('до загрузки ключи разметки присутствуют',
          ['stateFilters', 'rows', 'cols', 'isEmpty', 'hasRows', 'errorMsg', 'emptyNote']
            .every((k) => k in v));
    check('до загрузки пустое состояние не рисуется', v.isEmpty === false && v.hasRows === false);
  }

  // 2-4. Обычный ход: чипсы сходятся с summary.states, порядок строк — порядок
  //      очереди, пустых клеток в чипсах нет.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();

    const first = queueGets(calls)[0];
    check('первый запрос — limit/offset как у соседних экранов',
          !!first && first.q.limit === 50 && first.q.offset === 0);
    check('без фильтра параметр state на сервер не уходит', !!first && !('state' in first.q));

    const v = vals(c);
    check('renderVals после загрузки не падает', !v.__err);
    check('чипсов ровно шесть: «Все» и пять состояний',
          v.stateFilters.length === 6);

    for (const k of STATES) {
      const chip = v.stateFilters.find((f) => f.label && f.pick &&
        ['в очереди', 'читается', 'прочитано', 'ошибка', 'отменено'].indexOf(f.label) >= 0 &&
        f.label === {queued: 'в очереди', running: 'читается', done: 'прочитано',
                     failed: 'ошибка', canceled: 'отменено'}[k]);
      check('чипс «' + k + '» сходится с summary.states (' + LIST.summary.states[k] + ')',
            !!chip && chip.count === '· ' + LIST.summary.states[k]);
    }
    check('ноль показывается нулём, а не спрятан (canceled: 0)',
          v.stateFilters.some((f) => f.count === '· 0'));

    check('порядок строк совпадает с порядком items из ответа',
          v.rows.map((r) => r.id).join(',') === LIST.items.map((i) => i.id).join(','));
    check('в rows не ходят лишние работы', v.rows.length === LIST.items.length);
  }

  // 5. Фильтр-чипс: состояние уходит на сервер, «Все» снимает фильтр.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const queuedChip = v.stateFilters.find((f) => f.label === 'в очереди');
    check('чипс состояния несёт обработчик', !!queuedChip && typeof queuedChip.pick === 'function');
    if (queuedChip) {
      queuedChip.pick();
      await sleep();
    }
    const second = queueGets(calls)[1];
    check('чипс просит у сервера state=queued', !!second && second.q.state === 'queued');
    const v2 = vals(c);
    check('активный чипс подсвечен, строк отфильтрованы (в образце все состояния на одной странице — сервер фильтрует сам)',
          v2.stateFilters.some((f) => f.label === 'в очереди' && f.bg === '#131E5F'));

    const allChip = v2.stateFilters.find((f) => f.label === 'Все');
    if (allChip) { allChip.pick(); await sleep(); }
    const third = queueGets(calls)[2];
    check('чипс «Все» убирает фильтр из запроса', !!third && !('state' in third.q));
  }

  // 6. Кнопка снятия есть только у queued, работает и перечитывает очередь.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('кнопка снятия есть ровно у работ в состоянии queued',
          v.rows.every((r) => {
            const it = LIST.items.find((i) => i.id === r.id);
            return r.canRemove === (it.state === 'queued');
          }));

    const target = v.rows.find((r) => r.canRemove);
    const getsBefore = queueGets(calls).length;
    if (target) {
      check('у снимаемой работы есть обработчик', typeof target.remove === 'function');
      target.remove();
      await sleep();
    }
    const dels = calls.del.filter((d) => /^\/backfill\/queue\/\d+$/.test(d.p));
    check('снятие зовёт DELETE /backfill/queue/{id} ровно один раз',
          dels.length === 1 && target && dels[0].p === '/backfill/queue/' + target.id);
    check('после снятия очередь перечитана (позиции соседей сдвинулись)',
          queueGets(calls).length === getsBefore + 1);
    check('об успехе сказано тостом', calls.toasts.length === 1);
  }

  // 7. Отказ снятия показывается текстом сервера и очередь не трогает.
  {
    const {c, calls} = build({failRemove: true});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const target = v.rows.find((r) => r.canRemove);
    const getsBefore = queueGets(calls).length;
    if (target) { target.remove(); await sleep(); }
    check('отказ снятия виден тостом с текстом сервера, а не общим «ошибка»',
          calls.toasts.some((t) => t.c === '#DA501C' &&
            /уже взята воркером/.test(t.t)));
    check('отказ снятия не перечитывает очередь',
          queueGets(calls).length === getsBefore);
  }

  // 8. Причина отказа видна целиком — это то, ради чего колонка существует.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const failedItem = LIST.items.find((i) => i.state === 'failed');
    const row = v.rows.find((r) => r.id === failedItem.id);
    check('у упавшей работы причина отказа в строке',
          !!row && row.hasError === true && row.noError === false);
    check('текст отказа не обрезан многоточием и не переписан',
          !!row && row.errorText === failedItem.error);
    check('ход упавшей работы показывает, сколько успели прочитать',
          row.progress === 'прочитано ' + failedItem.read_total + ' из ' + failedItem.target);
  }

  // 9. Пустая очередь — пустое состояние, а не пустая таблица. И для «пусто»,
  //    и для «под фильтр ничего не подошло» текст свой.
  {
    const empty = {total: 0, limit: 50, offset: 0, items: [],
                   summary: {states: {queued: 0, running: 0, done: 0, failed: 0, canceled: 0},
                             by_account: {}}};
    const {c, calls} = build({list: empty});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('пустая очередь рисует пустое состояние, а не пустую таблицу',
          v.isEmpty === true && v.hasRows === false && v.rows.length === 0);
    check('у пустого состояния есть внятный текст',
          typeof v.emptyTitle === 'string' && v.emptyTitle.indexOf('пуста') >= 0 &&
          typeof v.emptyNote === 'string' && v.emptyNote.length > 20);
    check('чипсы и на пустой очереди показывают нули',
          v.stateFilters.some((f) => f.count === '· 0'));

    // Та же пустота под фильтром — другая новость, и текст другой.
    const queuedChip = v.stateFilters.find((f) => f.label === 'в очереди');
    if (queuedChip) { queuedChip.pick(); await sleep(); }
    v = vals(c);
    check('пустота под фильтром не выдаёт себя за пустую очередь',
          v.isEmpty === true && v.emptyTitle === 'Под фильтр ничего не подошло');
  }

  // 10. «Пусто» и «не пришло» различимы: чипс без числа из summary — прочерк.
  {
    const noCanceled = clone(LIST);
    delete noCanceled.summary.states.canceled;
    const {c} = build({list: noCanceled});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('состояние без числа в summary показано как «—», а не как 0',
          v.stateFilters.filter((f) => f.count === '· —').length === 1);

    const noSummary = clone(LIST);
    delete noSummary.summary;
    const c2 = build({list: noSummary}).c;
    await c2.componentDidMount();
    await sleep();
    const v2 = vals(c2);
    check('без summary все чипсы — прочерки, разбивка по аккаунтам скрыта',
          v2.stateFilters.filter((f) => f.count === '· —').length === 5 &&
          v2.hasByAccount === false);
  }

  // 11. Разбивка по аккаунтам — по summary.by_account, без выдуманных строк.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const keys = Object.keys(LIST.summary.by_account);
    check('строк разбивки столько, сколько аккаунтов прислал сервер',
          v.hasByAccount === true && v.byAccounts.length === keys.length);
    check('каждая строка разбивки названа и непуста',
          v.byAccounts.every((a) => /аккаунт \d+/.test(a.label) &&
            typeof a.note === 'string' && a.note.length > 0));
    check('перечислены именно ненулевые состояния аккаунта',
          v.byAccounts.find((a) => a.label === 'аккаунт 1').note.indexOf('ошибка') >= 0 &&
          v.byAccounts.find((a) => a.label === 'аккаунт 3').note.indexOf('ошибка') === -1);

    // Аккаунт со сплошными нулями — «свободен», а не строка из нулей.
    const idleAcc = clone(LIST);
    idleAcc.summary.by_account['9'] = {queued: 0, running: 0, done: 0, failed: 0, canceled: 0};
    const c2 = build({list: idleAcc}).c;
    await c2.componentDidMount();
    await sleep();
    const idle = vals(c2).byAccounts.find((a) => a.label === 'аккаунт 9');
    check('аккаунт без работ назван свободным', !!idle && idle.note === 'свободен');
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
