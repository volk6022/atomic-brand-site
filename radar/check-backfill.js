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

  // ── блок Б (волна К1): колонка «Поставил» и чипс источника ───────────────────
  // TESTS-autoflow-gui.md G-01…G-05. Значения — дословно из api-fixtures.json:
  // items[0].requested_by === 'ivan@example.com', в фикстуре уже есть работа
  // id 13 с requested_by === 'auto:join'.

  // G-01. Колонка «Поставил» дословно: requested_by показывается без
  // переписывания — это данные о том, кто заказал работу; обрезанный домен или
  // префикс делает «кто поставил» неразличимым, а колонку — декорацией.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-01 колонка «Поставил» есть в cols',
          v.cols.indexOf('Поставил') >= 0);
    check('G-01 «Поставил» стоит после «Аккаунта»',
          v.cols.indexOf('Поставил') > v.cols.indexOf('Аккаунт'));
    check('G-01 каждая строка показывает requested_by своего item дословно',
          v.rows.every((r) => {
            const it = LIST.items.find((i) => i.id === r.id);
            return r.reqBy === it.requested_by;
          }));
    const first = LIST.items[0];
    const row0 = v.rows.find((r) => r.id === first.id);
    check('G-01 items[0] — «ivan@example.com» без переписывания',
          !!row0 && row0.reqBy === 'ivan@example.com');
    check('G-01 метка «автоматика» стоит ровно у строк с префиксом auto:',
          v.rows.every((r) => {
            const it = LIST.items.find((i) => i.id === r.id);
            return (String(it.requested_by || '').indexOf('auto:') === 0) === !!r.isAuto;
          }) && !!row0 && row0.isAuto === false);

    // Пустой requested_by — прочерк, а не пустая клетка: «неизвестно» и
    // «поломка экрана» должны отличаться на взгляд.
    const noReq = clone(LIST);
    noReq.items[0].requested_by = null;
    const c2 = build({list: noReq}).c;
    await c2.componentDidMount();
    await sleep();
    const v2 = vals(c2);
    const row = v2.rows.find((r) => r.id === first.id);
    check('G-01 пустой requested_by показан прочерком',
          !!row && row.reqBy === '—' && row.noReq === true &&
          row.hasReq === false && row.isAuto === false);
  }

  // G-02. Автоматика помечена: префикс auto: — метка «автоматика» цветом
  // #C98A1E и ПОЛНЫЙ текст рядом (auto:join от auto:channel_add отличить —
  // единственная причина префикса). Метка ставится по префиксу, а не всем
  // подряд. Второй префикс — auto:channel_add из CONTRACT-autoflow-gui.md §4.1.
  {
    const withAuto = clone(LIST);
    withAuto.items[1].requested_by = 'auto:join';
    withAuto.items[2].requested_by = 'auto:channel_add';
    const {c} = build({list: withAuto});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    // Авто-множество выводим из самого поданного списка (items[1], items[2]
    // мутированы + в фикстуре уже есть id 13 с auto:join) — метка обязана
    // стоять ровно у строк с префиксом, у остальных её быть не должно.
    check('G-02 ровно строки с auto: несут метку «автоматика» #C98A1E',
          v.rows.every((r) => {
            const it = withAuto.items.find((i) => i.id === r.id);
            const want = String(it.requested_by || '').indexOf('auto:') === 0;
            return want
              ? (r.isAuto === true && r.autoLabel === 'автоматика' &&
                 r.autoColor === '#C98A1E')
              : r.isAuto === false;
          }));
    check('G-02 полный текст auto:join / auto:channel_add стоит рядом с меткой',
          v.rows.find((r) => r.id === withAuto.items[1].id).reqBy === 'auto:join' &&
          v.rows.find((r) => r.id === withAuto.items[2].id).reqBy === 'auto:channel_add');
    check('G-02 фикстурная работа auto:join (id 13) тоже помечена',
          (() => {
            const r = v.rows.find((x) => x.id === 13);
            return !!r && r.isAuto === true && r.reqBy === 'auto:join';
          })());
  }

  // G-03. Чипсы источника: три, «Все / авто / руками»; без фильтра подсвечен
  // «Все», подсветка — той же парой цветов, что у состояний (#131E5F/#F8F3E0).
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('G-03 чипсов источника три: «Все / авто / руками»',
          v.sourceFilters.length === 3 &&
          v.sourceFilters.map((f) => f.label).join('/') === 'Все/авто/руками');
    check('G-03 без фильтра подсвечен «Все», остальные прозрачны',
          v.sourceFilters[0].bg === '#131E5F' &&
          v.sourceFilters[1].bg === 'transparent' &&
          v.sourceFilters[2].bg === 'transparent');
    const autoChip = v.sourceFilters.find((f) => f.label === 'авто');
    check('G-03 чипс источника несёт обработчик',
          !!autoChip && typeof autoChip.pick === 'function');
    if (autoChip) { autoChip.pick(); await sleep(); }
    v = vals(c);
    check('G-03 активный чипс источника подсвечен',
          v.sourceFilters.find((f) => f.label === 'авто').bg === '#131E5F' &&
          v.sourceFilters.find((f) => f.label === 'Все').bg === 'transparent');
  }

  // G-04. Выбор источника уходит на сервер параметром source=auto|manual,
  // «Все» не шлёт параметра вовсе («пустые не отправляются»); состояние и
  // источник — независимые срезы, клик по одному не сбрасывает другой.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    const autoChip = v.sourceFilters.find((f) => f.label === 'авто');
    if (autoChip) { autoChip.pick(); await sleep(); }
    const second = queueGets(calls)[1];
    check('G-04 чипс «авто» шлёт source=auto',
          !!second && second.q.source === 'auto');

    v = vals(c);
    const manualChip = v.sourceFilters.find((f) => f.label === 'руками');
    if (manualChip) { manualChip.pick(); await sleep(); }
    const third = queueGets(calls)[2];
    check('G-04 чипс «руками» шлёт source=manual',
          !!third && third.q.source === 'manual');

    v = vals(c);
    const allChip = v.sourceFilters.find((f) => f.label === 'Все');
    if (allChip) { allChip.pick(); await sleep(); }
    const fourth = queueGets(calls)[3];
    check('G-04 чипс «Все» не шлёт параметра source',
          !!fourth && !('source' in fourth.q));

    // Независимость срезов — на свежем стенде: предыдущие клики в этом сценарии
    // закончились «Все», и source закономерно пуст.
    const again = build();
    await again.c.componentDidMount();
    await sleep();
    const v3 = vals(again.c);
    const autoChip2 = v3.sourceFilters.find((f) => f.label === 'авто');
    const queuedChip = v3.stateFilters.find((f) => f.label === 'в очереди');
    if (autoChip2) { autoChip2.pick(); await sleep(); }
    if (queuedChip) { queuedChip.pick(); await sleep(); }
    const fifth = queueGets(again.calls)[2];
    check('G-04 фильтр источника держится при смене состояния',
          !!fifth && fifth.q.source === 'auto' && fifth.q.state === 'queued');
  }

  // Пустота под фильтром источника — «под фильтр», а не «очередь пуста»:
  // две разные новости, как и у состояний.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const manualChip = v.sourceFilters.find((f) => f.label === 'руками');
    if (manualChip) { manualChip.pick(); await sleep(); }
    const v2 = vals(c);
    check('G-04 пустота под фильтром источника названа «Под фильтр ничего не подошло»',
          v2.emptyTitle === 'Под фильтр ничего не подошло');
  }

  // G-05. Существующее не сломано — это сам прогон: проверки 1–11 этого файла
  // (чипсы состояний против summary.states, порядок строк, снятие только у
  // queued, пустые состояния, разбивка по аккаунтам) остаются зелёными без
  // единой правки; итоговая строка ниже считает и их, и блок Б.

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
