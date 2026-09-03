// Поведенческая проверка двух экранов черновиков — карточки и таблицы.
//
// Проверяется одна вещь, ради которой очередь черновиков вообще открывают:
// человек рассылает РУКАМИ, входит в ОДИН аккаунт Telegram и пишет с него.
// Наводка пришла из группы, которую читал конкретный аккаунт; написать адресату
// с другого — прийти «ниоткуда», без общих групп и истории. Значит экран обязан
// называть аккаунт приёма, давать по нему фильтр и отдавать готовые юзернейм и
// ссылку в буфер обмена. Плюс отличать комментарий под постом от сообщения в
// группе: найти его в группе и найти в канале — разные вещи, когда в группу ещё
// не вступили.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики.
// Ни один из них не нажимает на кнопки и не знает, ЧТО экран спросил у сервера.
// Здесь проверяется именно это: файл исполняет настоящую логику под записывающим
// API и сверяет запросы и значения. Это контракт: правится экран, а не файл.
//
//   node check-drafts.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

const NEXT = fixtures['/workflows/{key}/drafts/next'];
const ONE = fixtures['/workflows/{key}/drafts/{id}'];
const QUEUE = fixtures['/workflows/{key}/drafts'];
const OPTIONS = fixtures['/workflows/{key}/drafts/accounts'];
const LEGACY = fixtures['/drafts/list'];
const REASONS = fixtures['/drafts/reasons'];
if (!NEXT || !QUEUE || !OPTIONS || !LEGACY) {
  console.error('нет образцов ответа. Пересними: python scripts/dump_gui_fixtures.py');
  process.exit(2);
}

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const WF = 'public_reply';

// ── стенд ─────────────────────────────────────────────────────────────────────
//
// Один и тот же стенд на оба экрана: они ходят в один и тот же сервер и обязаны
// понимать один и тот же ответ. Разойдись они формой — аккаунт был бы виден
// только в одном из двух мест, и заметили бы это не сразу.

function build(file, props, opts) {
  opts = opts || {};
  const src = fs.readFileSync(DIR + '/' + file, 'utf8');
  const logic = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const calls = {get: [], post: [], copied: [], toasts: []};

  const api = {
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      if (opts.fail) throw new Error('сервер недоступен');
      if (/\/drafts\/accounts$/.test(p)) {
        if (opts.failOptions) throw new Error('список аккаунтов недоступен');
        return clone(opts.options || OPTIONS);
      }
      if (/\/drafts\/next$/.test(p)) return clone(opts.next || NEXT);
      if (p === '/drafts/list') return clone(LEGACY);
      if (/\/drafts$/.test(p)) return clone(opts.queue || QUEUE);
      if (p === '/drafts/reasons') return clone(REASONS || {rows: []});
      if (/\/drafts\/\d+$/.test(p)) return clone(opts.one || ONE || NEXT);
      if (p === '/channels/options') return clone(fixtures['/channels/options']);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => { calls.post.push({p: p, body: body || {}}); return {ok: true}; },
    patch: async () => ({ok: true}),
    describe: (e) => 'ошибка: ' + (e && e.message ? e.message : e),
    isUnauthorized: () => false,
    isForbidden: () => false,
  };

  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, RegExp,
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: opts.hash || ''},
    history: {replaceState: (a, b, url) => { ctx.location.hash = String(url || ''); }},
    navigator: {clipboard: opts.noClipboard ? undefined : {
      writeText: async (t) => {
        if (opts.clipboardFails) throw new Error('буфер обмена запрещён');
        calls.copied.push(t);
      },
    }},
    document: {
      // Запасной путь копирования: временный <textarea> и execCommand. Стенд его
      // не эмулирует всерьёз — важно лишь, что экран не падает без clipboard.
      createElement: () => ({style: {}, focus() {}, select() {}, setAttribute() {}}),
      body: {appendChild() {}, removeChild() {}},
      execCommand: (cmd) => { calls.copied.push('execCommand:' + cmd); return true; },
    },
    window: {addEventListener() {}, removeEventListener() {}, open() {}},
  };
  ctx.__imp = async () => api;
  vm.createContext(ctx);

  const base = `
    class DCLogic {
      constructor(p){ this.props = Object.assign(
        {api:{toast:(t)=>__toasts.push(t), drill(){}, trace(){}, go(){}, modal(){}},
         mobile:false}, p || {}); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__toasts = calls.toasts;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(props || {}), calls: calls, ctx: ctx};
}

const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; } };
const settle = () => new Promise((r) => setTimeout(r, 40));

// Кнопка копирования по контракту — {show, label, act}. Проверяем форму отдельно
// от поведения: иначе «нет ключа» и «не копирует» неотличимы в выводе.
function isButton(b) {
  return !!b && typeof b === 'object' && 'show' in b && typeof b.act === 'function';
}

async function press(btn) {
  if (!isButton(btn)) return;
  try { await btn.act({stopPropagation() { press._stopped = true; }}); }
  catch (e) { press._threw = e; }
  await settle();
}

// ── карточка ──────────────────────────────────────────────────────────────────

async function card() {
  // 1. Ключи контракта есть ДО загрузки. Дырка `{{ имя }}`, которой нет в
  //    renderVals, не даёт ошибки — ячейка молча остаётся пустой.
  {
    const {c} = build('RadarDrafts.dc.html', {workflow: WF});
    const v = vals(c);
    check('карточка: renderVals() до загрузки не падает', !v.__err);
    for (const k of ['readerNames', 'hasReaders', 'copyUsername', 'copyLink',
                     'isComment', 'postLink', 'postLabel']) {
      check('карточка: ключ ' + k + ' есть до загрузки', k in v);
    }
  }

  // 2. Обычный ход: аккаунт приёма назван подписью, а не номером.
  {
    const draft = clone(NEXT);
    draft.draft.readers = [{account_id: 12, label: 'acc-12'},
                           {account_id: 13, label: 'acc-13'}];
    draft.draft.author_username = '@user_17';
    draft.draft.tg_link = 'https://t.me/user_17';
    draft.draft.source = {is_comment: false, post_link: null,
                          post_channel: null, comment_link: 'https://t.me/chat/1'};

    const {c, calls} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);

    check('карточка: спрошена очередь сценария, а не общая',
          calls.get.some((g) => g.p === '/workflows/' + WF + '/drafts/next'));
    check('карточка: аккаунты приёма названы подписями',
          typeof v.readerNames === 'string'
          && v.readerNames.indexOf('acc-12') >= 0 && v.readerNames.indexOf('acc-13') >= 0);
    check('карточка: hasReaders истинно, когда читатели есть', v.hasReaders === true);
    check('карточка: подпись не показывает голый номер аккаунта',
          typeof v.readerNames === 'string' && !/\b12\b/.test(v.readerNames.replace(/acc-\d+/g, '')));

    check('карточка: кнопка копирования юзернейма показана', isButton(v.copyUsername)
          && v.copyUsername.show === true);
    check('карточка: кнопка копирования ссылки показана', isButton(v.copyLink)
          && v.copyLink.show === true);

    await press(v.copyUsername);
    check('карточка: копируется именно юзернейм',
          calls.copied.some((t) => String(t).indexOf('user_17') >= 0));
    const before = calls.copied.length;
    await press(v.copyLink);
    check('карточка: копируется именно ссылка',
          calls.copied.slice(before).some((t) => String(t).indexOf('https://t.me/') === 0));
    check('карточка: копирование подтверждено человеку', calls.toasts.length > 0);
  }

  // 3. Пустой список читателей — старая запись, до атрибуции приёма. Не поломка.
  {
    const draft = clone(NEXT);
    draft.draft.readers = [];
    const {c} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('карточка: без читателей renderVals не падает', !v.__err);
    check('карточка: без читателей стоит прочерк, а не пустая строка',
          typeof v.readerNames === 'string' && v.readerNames.trim().length > 0);
    check('карточка: hasReaders ложно, когда читателей нет', v.hasReaders === false);
  }

  // 4. Автор без юзернейма: ссылку строить не из чего. Нерабочая кнопка хуже,
  //    чем отсутствующая — человек нажмёт и решит, что скопировал.
  {
    const draft = clone(NEXT);
    draft.draft.author_username = null;
    draft.draft.tg_link = null;
    const {c} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('карточка: без юзернейма кнопка копирования спрятана',
          isButton(v.copyUsername) && v.copyUsername.show === false);
    check('карточка: без ссылки кнопка ссылки спрятана',
          isButton(v.copyLink) && v.copyLink.show === false);
  }

  // 5. Комментарий под постом: ссылка ведёт в КАНАЛ, а не в группу.
  {
    const draft = clone(NEXT);
    draft.draft.source = {is_comment: true, post_link: 'https://t.me/andrey_channel/499',
                          post_channel: 'Канал про закупки',
                          comment_link: 'https://t.me/chat/1421'};
    const {c} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('карточка: комментарий под постом опознан', v.isComment === true);
    check('карточка: ссылка ведёт на пост, а не на комментарий',
          v.postLink === 'https://t.me/andrey_channel/499');
    check('карточка: у ссылки на пост человеческая подпись',
          typeof v.postLabel === 'string' && v.postLabel.indexOf('Канал про закупки') >= 0);
  }

  // 6. Комментарий есть, ссылки на пост нет — так бывает: корень ветки известен,
  //    а номер поста в канале нет. Пометка обязана остаться, ссылка — исчезнуть.
  {
    const draft = clone(NEXT);
    draft.draft.source = {is_comment: true, post_link: null, post_channel: null,
                          comment_link: 'https://t.me/chat/1421'};
    const {c} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('карточка: пометка о комментарии есть и без ссылки на пост', v.isComment === true);
    check('карточка: несуществующая ссылка на пост пуста, а не «null»',
          v.postLink === '' || v.postLink === null || v.postLink === undefined);
  }

  // 6b. Четвёртое состояние. «Всё, что не pending, — отклонено» подписывало
  //     правленый черновик как «отклонён: —»: человек читает про отказ там, где
  //     его никто не выносил.
  {
    const draft = clone(NEXT);
    draft.draft.state = 'edited';
    draft.draft.reject_reason = null;
    const {c} = build('RadarDrafts.dc.html', {workflow: WF}, {next: draft});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('карточка: правленый черновик не подписан отказом',
          typeof v.queueLabel === 'string' && v.queueLabel.indexOf('отклонён') === -1,
          String(v.queueLabel));
  }

  // 7. Отказ буфера обмена — сбой окружения, а не повод потерять экран.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {workflow: WF},
                             {clipboardFails: true});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    press._threw = null;
    await press(v.copyUsername);
    check('карточка: отказ буфера обмена не выбрасывает исключение наружу',
          !press._threw);
    check('карточка: после отказа буфера экран цел', !vals(c).__err);
  }
}

// ── таблица ───────────────────────────────────────────────────────────────────

async function table() {
  const F = 'RadarDraftsTable.dc.html';
  const q = (calls, re) => calls.get.filter((g) => re.test(g.p));

  // 8. Ключи контракта есть до загрузки.
  {
    const {c} = build(F, {workflow: WF});
    const v = vals(c);
    check('таблица: renderVals() до загрузки не падает', !v.__err);
    for (const k of ['accounts', 'account', 'setAccount', 'hasAccounts']) {
      check('таблица: ключ ' + k + ' есть до загрузки', k in v);
    }
  }

  // 9-13. В разрезе сценария: своя ручка, свой список аккаунтов, свой фильтр.
  {
    const {c, calls, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();

    check('таблица: в разрезе сценария спрошена его очередь',
          q(calls, /^\/workflows\/public_reply\/drafts$/).length === 1);
    check('таблица: общая очередь при этом НЕ спрашивалась',
          q(calls, /^\/drafts\/list$/).length === 0);
    check('таблица: список аккаунтов спрошен у сценария',
          q(calls, /\/drafts\/accounts$/).length === 1);

    const v = vals(c);
    check('таблица: выпадающий список аккаунтов показан', v.hasAccounts === true);
    check('таблица: первый пункт — «все аккаунты» с пустым значением',
          Array.isArray(v.accounts) && v.accounts.length > 1 && v.accounts[0].value === '');
    check('таблица: пункт называет аккаунт подписью',
          Array.isArray(v.accounts)
          && v.accounts.slice(1).every((a) => String(a.label).indexOf('acc-') >= 0));
    check('таблица: пункт называет число черновиков',
          Array.isArray(v.accounts)
          && v.accounts.slice(1).some((a) => /\d/.test(String(a.label))));

    // Выбор аккаунта уходит на сервер параметром, а не режет уже полученную
    // страницу: очередь растёт вместе с приёмом, и отбор по странице — отбор не того.
    if (typeof v.setAccount === 'function') {
      v.setAccount({target: {value: '12'}});
      await settle();
    }
    const last = q(calls, /^\/workflows\/public_reply\/drafts$/).pop();
    check('таблица: выбранный аккаунт ушёл на сервер параметром account_id',
          !!last && String(last.q.account_id) === '12');
    check('таблица: список аккаунтов не перезапрашивается на каждый фильтр',
          q(calls, /\/drafts\/accounts$/).length === 1);
    check('таблица: срез по аккаунту попал в адрес строки браузера',
          /account=12/.test(String(ctx.location.hash || '')));
  }

  // 14-15. Без сценария поведение прежнее — дословно. Иначе общий раздел
  //        черновиков сломался бы ради нового.
  {
    const {c, calls} = build(F, {});
    await c.componentDidMount();
    await settle();
    check('таблица: без сценария спрошена прежняя общая очередь',
          q(calls, /^\/drafts\/list$/).length === 1);
    check('таблица: без сценария список аккаунтов не спрашивается',
          q(calls, /\/drafts\/accounts$/).length === 0);
    const v = vals(c);
    check('таблица: без сценария фильтра по аккаунту нет', v.hasAccounts === false);
  }

  // 16-20. Строка: аккаунт, кнопки, комментарий.
  {
    const queue = clone(QUEUE);
    queue.rows[0].readers = [{account_id: 12, label: 'acc-12'}];
    queue.rows[0].author_username = '@user_17';
    queue.rows[0].tg_link = 'https://t.me/user_17';
    queue.rows[0].source = {is_comment: true, post_link: 'https://t.me/ch/499',
                            post_channel: 'Канал про закупки',
                            comment_link: 'https://t.me/chat/1'};
    queue.rows[1].readers = [];

    const {c, calls} = build(F, {workflow: WF}, {queue: queue});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    const r0 = (v.rows || [])[0] || {};
    const r1 = (v.rows || [])[1] || {};

    check('таблица: в строке назван аккаунт приёма',
          typeof r0.accounts === 'string' && r0.accounts.indexOf('acc-12') >= 0);
    check('таблица: строка без читателей показывает прочерк',
          typeof r1.accounts === 'string' && r1.accounts.trim().length > 0);
    check('таблица: комментарий под постом помечен в строке', r0.isComment === true);
    check('таблица: в строке есть ссылка на пост', r0.postLink === 'https://t.me/ch/499');

    press._stopped = false;
    await press(r0.copyLink);
    check('таблица: из строки копируется ссылка',
          calls.copied.some((t) => String(t).indexOf('https://t.me/user_17') >= 0));
    check('таблица: копирование не открывает черновик (всплытие погашено)',
          press._stopped === true);

    check('таблица: текст строки взят из варианта или цитаты, а не пуст',
          typeof r0.text === 'string' && r0.text.trim().length > 0);
    check('таблица: счётчики состояний разобраны из массива, а не из объекта',
          Array.isArray(v.filters) && v.filters.some((f) => /\d/.test(String(f.count))));
  }

  // 20b. Чипсы строятся по тому, что вернул сервер. Зашитый список из трёх
  //      состояний прятал целое четвёртое: черновик считался только под «Все»,
  //      а в строке светилось английское слово из базы.
  {
    const {c} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    const labels = (v.filters || []).map((f) => String(f.label));
    const serverStates = (QUEUE.states || []).map((x) => x.key);
    check('таблица: у каждого состояния сервера есть свой чипс',
          serverStates.length + 1 === labels.length, labels.join(' / '));
    const row = (v.rows || []).filter((r) => /^[a-z]+$/.test(String(r.state)));
    check('таблица: ни одно состояние не показано английским словом из базы',
          row.length === 0, JSON.stringify(row.map((r) => r.state)));
  }

  // 21. Ссылка на срез открывает срез: адрес читается ДО первой загрузки.
  //
  // Хеш взят в том виде, в каком его пишет оболочка, — с приставкой сценария.
  // Раньше здесь стоял голый «#draftsTable», и проверка описывала мир, которого
  // нет: внутри сценария оболочка такого адреса не ставит никогда, а экран под
  // этот выдуманный адрес и подгонялся.
  {
    const {c, calls} = build(F, {workflow: WF},
                             {hash: '#wf:public_reply:draftsTable?account=13&filter=pending'});
    await c.componentDidMount();
    await settle();
    const first = q(calls, /^\/workflows\/public_reply\/drafts$/)[0];
    check('таблица: срез из адреса применён к ПЕРВОМУ запросу',
          !!first && String(first.q.account_id) === '13');
  }

  // 21a. Обратная запись обязана сохранить сценарий. Адрес — это то, что человек
  //      скопирует из строки браузера и пришлёт себе же завтра; потеряв приставку,
  //      он открывает СТАРУЮ общую очередь: без колонки аккаунта, с другим числом
  //      строк и без фильтра, ради которого экран и делался.
  {
    const {c, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const h = String(ctx.location.hash || '');
    check('таблица: в адресе сохранён маршрут сценария, а не общий',
          h.indexOf('#wf:public_reply:draftsTable') === 0, h);

    const v = vals(c);
    if (typeof v.setAccount === 'function') { v.setAccount({target: {value: '12'}}); await settle(); }
    const h2 = String(ctx.location.hash || '');
    check('таблица: срез по аккаунту записан внутри маршрута сценария',
          h2.indexOf('#wf:public_reply:draftsTable?') === 0 && /account=12/.test(h2), h2);
  }

  // 21b. Вне сценария адрес прежний, дословно: у общего раздела приставки нет.
  {
    const {c, ctx} = build(F, {});
    await c.componentDidMount();
    await settle();
    const h = String(ctx.location.hash || '');
    check('таблица: без сценария адрес остался голым «#draftsTable»',
          h === '#draftsTable' || h.indexOf('#draftsTable?') === 0, h);
  }

  // 22. Недоступный список аккаунтов не уносит с собой очередь: фильтр — удобство,
  //     а черновики — работа.
  {
    const {c} = build(F, {workflow: WF}, {failOptions: true});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('таблица: сбой списка аккаунтов не роняет renderVals', !v.__err);
    check('таблица: сбой списка аккаунтов оставляет строки на месте',
          Array.isArray(v.rows) && v.rows.length > 0);
  }
}

async function main() {
  await card();
  await table();

  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
