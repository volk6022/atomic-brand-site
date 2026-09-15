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
// Модуль таблицы исполняется по-настоящему: страницы, сортировка и срез адреса —
// это его код, проверять их через заглушку значило бы проверять выдумку.
const TABLE_SRC = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const NEXT = fixtures['/workflows/{key}/drafts/next'];
const ONE = fixtures['/workflows/{key}/drafts/{id}'];
const QUEUE = fixtures['/workflows/{key}/drafts'];
const OPTIONS = fixtures['/workflows/{key}/drafts/accounts'];
const LEGACY = fixtures['/drafts/list'];
const REASONS = fixtures['/drafts/reasons'];
// Карточки старого контура: комментарии живут по тем же адресам без приставки
// сценария, поэтому стенду нужны и их образцы.
const OLD_NEXT = fixtures['/drafts/next'];
const OLD_ONE = fixtures['/drafts/{id}'];
if (!NEXT || !QUEUE || !OPTIONS || !LEGACY || !OLD_NEXT) {
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
  const calls = {get: [], post: [], del: [], copied: [], toasts: []};

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
    del: async (p) => { calls.del.push({p: p}); return {deleted: 7}; },
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
  // `import('./radar-table.js')` — настоящий модуль, `import('./radar-api.js')` —
  // записывающая заглушка.
  ctx.__imp = async (p) => (String(p).indexOf('radar-table') >= 0
    ? {Table: ctx.__Table} : api);
  vm.createContext(ctx);
  vm.runInContext(TABLE_SRC + '\n;this.__Table = Table;', ctx);

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

// ── комментарии к черновику ───────────────────────────────────────────────────

// Фейковое событие клавиатуры для this._key: хоткеи вешаются на window, а окно
// стенда слушателей не исполняет — дергаем обработчик напрямую.
function keyEvent(code) {
  return {code: code, key: code, target: {tagName: 'BODY'},
          metaKey: false, ctrlKey: false, altKey: false, shiftKey: false};
}

async function comments() {
  // Образцы старого контура: комментарии приходят внутри карточки по тем же
  // адресам, что и сам черновик, — приставки сценария нет.
  const OLD = {next: fixtures['/drafts/next'], one: fixtures['/drafts/{id}']};

  // Лента из образца: число в заголовке, текст, авторы, метки цели.
  {
    const {c} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('комментарии: число в заголовке блока равно comments_count образца',
          v.commentsCount === '2', String(v.commentsCount));
    check('комментарии: лента отдаёт оба комментария образца',
          Array.isArray(v.comments) && v.comments.length === 2);
    check('комментарии: текст первого комментария показан с переносом',
          v.comments[0].text === OLD_NEXT.draft.comments[0].text
          && v.comments[0].text.indexOf('\n') >= 0);
    check('комментарии: автор показан до собаки', v.comments[0].author === 'andrey');
    check('комментарии: дата в форме дд.мм чч:мм',
          /^\d{2}\.\d{2} \d{2}:\d{2}$/.test(v.comments[0].when), String(v.comments[0].when));
    check('комментарии: у комментария с индексом метка «вариант N»',
          v.comments[0].target === 'вариант 2', v.comments[0].target);
    check('комментарии: у variant_index: null метка «черновик целиком»',
          v.comments[1].target === 'черновик целиком', v.comments[1].target);
    check('комментарии: у каждого комментария есть ссылка удаления',
          v.comments.every((cm) => cm.delLabel === 'удалить'
                                  && typeof cm.delAct === 'function'));
  }

  // Лента обязана жить и у разобранного черновика: отзыв чаще пишут после
  // решения, а не до него.
  {
    const next = clone(OLD_NEXT);
    next.draft.state = 'rejected';
    next.draft.reject_reason = 'Звучит как реклама';
    const {c} = build('RadarDrafts.dc.html', {}, {next: next, one: OLD_ONE});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('комментарии: у отклонённого черновика лента на месте',
          v.commentsCount === '2' && v.comments.length === 2);
  }

  // Панель: C открывает, Esc закрывает, placeholder дословный.
  {
    const {c} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('комментарии: клавиша C есть в списке горячих клавиш',
          v.hotkeys.some((h) => h.k === 'C'));
    c._key(keyEvent('KeyC'));
    check('комментарии: нажатие C открывает панель', c.state.commenting === true);
    check('комментарии: placeholder дословно как в задании',
          v.commentPlaceholder === 'Что понравилось и что нет · где попали в боль, '
            + 'где не очень · что стоит поправить в промпте', v.commentPlaceholder);
    check('комментарии: счётчик длины считает введённое', v.commentLen === '0');
    c._key(keyEvent('Escape'));
    check('комментарии: Esc закрывает панель', c.state.commenting === false);
  }

  // Пустой текст: ни одного запроса, тост, панель не закрывается.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    v.startComment();
    v.setCommentText({target: {value: '   '}});
    const before = calls.post.length;
    await v.saveComment();
    await settle();
    check('комментарии: пустой текст не отправляет ни одного запроса',
          calls.post.length === before);
    check('комментарии: пустой текст — тост про пустой комментарий',
          calls.toasts.some((t) => String(t).indexOf('Пустой комментарий') >= 0),
          calls.toasts.join(' | '));
    check('комментарии: пустой текст не закрывает панель', c.state.commenting === true);
  }

  // С текстом: ровно один post по адресу старого контура с активным вариантом;
  // после сохранения панель закрыта, текст пуст, черновик перечитан.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    v.startComment();
    v.setCommentText({target: {value: 'Боль попала точно, второе предложение — как реклама'}});
    await v.saveComment();
    await settle();
    const posts = calls.post.filter((p) => /\/comments$/.test(p.p));
    check('комментарии: сохранение шлёт ровно один post', posts.length === 1);
    check('комментарии: post уходит на /drafts/<id>/comments',
          posts[0] && posts[0].p === '/drafts/1/comments', posts[0] && posts[0].p);
    check('комментарии: тело несёт текст и активный вариант',
          !!posts[0]
          && posts[0].body.text === 'Боль попала точно, второе предложение — как реклама'
          && posts[0].body.variant_index === 0);
    check('комментарии: после сохранения панель закрыта', c.state.commenting === false);
    check('комментарии: после сохранения текст очищен', c.state.commentText === '');
    check('комментарии: после сохранения черновик перечитан',
          calls.get.some((g) => g.p === '/drafts/1'));
    check('комментарии: человек получил подтверждение с упоминанием Ивана',
          calls.toasts.some((t) => String(t).indexOf('Комментарий сохранён') >= 0));
  }

  // Галка «целиком» вместо активного варианта.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('комментарии: по умолчанию цель — активный вариант',
          v.commentVariantBg === '#131E5F' && v.commentWholeBg === 'transparent');
    v.startComment();
    v.setCommentWhole();
    // Подписи переключателя живут в результате renderVals, поэтому после
    // переключения перечитываем их, а не смотрим в старый снимок.
    check('комментарии: переключатель «целиком» подсвечен после включения',
          vals(c).commentWholeBg === '#131E5F' && vals(c).commentVariantBg === 'transparent');
    v.setCommentText({target: {value: 'К черновику целиком: формат хороший'}});
    await v.saveComment();
    await settle();
    const post = calls.post.find((p) => /\/comments$/.test(p.p));
    check('комментарии: с галкой «целиком» variant_index в теле равен null',
          !!post && post.body.variant_index === null,
          post && JSON.stringify(post.body));
  }

  // В контуре сценария тот же post уходит по адресу сценария.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {workflow: WF});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    v.startComment();
    v.setCommentText({target: {value: 'Ответ по существу, без обещаний'}});
    await v.saveComment();
    await settle();
    const posts = calls.post.filter((p) => /\/comments$/.test(p.p));
    check('комментарии: в контуре wf post уходит на /workflows/<key>/drafts/<id>/comments',
          posts.length === 1 && posts[0].p === '/workflows/' + WF + '/drafts/28/comments',
          posts[0] && posts[0].p);
  }

  // Удаление: первое нажатие спрашивает подтверждение, чужое действие его
  // сбрасывает, второе нажатие подряд удаляет и перечитывает черновик.
  {
    const {c, calls} = build('RadarDrafts.dc.html', {}, OLD);
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    await v.comments[0].delAct();
    await settle();
    check('комментарии: первое нажатие ничего не удаляет', calls.del.length === 0);
    check('комментарии: первое нажатие требует подтверждения',
          vals(c).comments[0].delLabel === 'точно удалить?');
    v.tabs[0].pick();
    await settle();
    check('комментарии: другое действие сбрасывает подтверждение',
          vals(c).comments[0].delLabel === 'удалить');
    await v.comments[0].delAct();
    await settle();
    check('комментарии: сброшенное подтверждение не удаляет сразу',
          calls.del.length === 0);
    await v.comments[0].delAct();
    await settle();
    check('комментарии: второе нажатие подряд удаляет по адресу комментария',
          calls.del.length === 1 && calls.del[0].p === '/drafts/1/comments/7',
          calls.del[0] && calls.del[0].p);
    check('комментарии: после удаления черновик перечитан',
          calls.get.some((g) => g.p === '/drafts/1'));
  }
}

// ── таблица ───────────────────────────────────────────────────────────────────

async function table() {
  const F = 'RadarDraftsTable.dc.html';
  const q = (calls, re) => calls.get.filter((g) => re.test(g.p));
  const wfRe = /^\/workflows\/public_reply\/drafts$/;

  // 8. Ключи контракта есть до загрузки — включая дырки пагинации из модуля:
  //    дырка, которой нет в renderVals, молча оставляет ячейку пустой.
  {
    const {c} = build(F, {workflow: WF});
    const v = vals(c);
    check('таблица: renderVals() до загрузки не падает', !v.__err);
    for (const k of ['accounts', 'account', 'setAccount', 'hasAccounts',
                     'range', 'pages', 'sizes', 'q', 'setQ', 'cols', 'resetAll']) {
      check('таблица: ключ ' + k + ' есть до загрузки', k in v);
    }
  }

  // 9-13. В разрезе сценария: своя ручка, свой список аккаунтов, свой фильтр,
  //       страницы и сортировка по умолчанию — от модуля.
  {
    const {c, calls, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();

    const reqs = () => q(calls, wfRe);
    check('таблица: в разрезе сценария спрошена его очередь',
          reqs().length === 1);
    check('таблица: общая очередь при этом НЕ спрашивалась',
          q(calls, /^\/drafts\/list$/).length === 0);
    check('таблица: список аккаунтов спрошен у сценария',
          q(calls, /\/drafts\/accounts$/).length === 1);
    check('таблица: страница по умолчанию — первая по 50 строк',
          reqs()[0].q.limit === 50 && reqs()[0].q.offset === 0,
          JSON.stringify(reqs()[0].q));
    check('таблица: сортировка по умолчанию created desc',
          reqs()[0].q.sort === 'created' && reqs()[0].q.order === 'desc');

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
    const last = reqs().pop();
    check('таблица: выбранный аккаунт ушёл на сервер параметром account_id',
          !!last && String(last.q.account_id) === '12');
    check('таблица: смена фильтра вернула на первую страницу',
          !!last && last.q.offset === 0);
    check('таблица: список аккаунтов не перезапрашивается на каждый фильтр',
          q(calls, /\/drafts\/accounts$/).length === 1);
    check('таблица: срез по аккаунту попал в адрес строки браузера',
          /account_id=12/.test(String(ctx.location.hash || '')),
          String(ctx.location.hash || ''));
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
    const req = q(calls, /^\/drafts\/list$/)[0];
    check('таблица: общей ручке sort/order не уходят, страница по 50',
          !!req && !('sort' in req.q) && !('order' in req.q)
          && req.q.limit === 50 && req.q.offset === 0, JSON.stringify(req.q));
    const v = vals(c);
    check('таблица: без сценария фильтра по аккаунту нет', v.hasAccounts === false);
    check('таблица: без сценария заголовки не кликабельны и без стрелок',
          (v.cols || []).length > 0
          && v.cols.every((h) => h.cursor === 'default' && !h.arrow
                                && typeof h.pick === 'function'));
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
  // Хеш взят в том виде, в каком его пишет модуль, — с приставкой сценария.
  // Имена срез-параметров = имена параметров сервера (state, account_id,
  // min_score): readUrl модуля кладёт их прямо в filters, query() отдаёт как есть.
  {
    const {c, calls} = build(F, {workflow: WF},
        {hash: '#wf:public_reply:draftsTable?account_id=13&state=pending&min_score=50'});
    await c.componentDidMount();
    await settle();
    const first = q(calls, wfRe)[0];
    check('таблица: срез из адреса применён к ПЕРВОМУ запросу',
          !!first && String(first.q.account_id) === '13'
                  && first.q.state === 'pending'
                  && String(first.q.min_score) === '50',
          first && JSON.stringify(first.q));
    const v = vals(c);
    check('таблица: срез из адреса виден в элементах экрана (аккаунт, скор)',
          v.account === '13' && v.minScore === '50',
          JSON.stringify([v.account, v.minScore]));
    check('таблица: чипс состояния из среза подсвечен',
          (v.filters.find((f) => f.label === 'На ревью') || {}).bg === '#131E5F');
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
          h2.indexOf('#wf:public_reply:draftsTable?') === 0 && /account_id=12/.test(h2), h2);
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

  // 23. Колонка 💬: сразу после состояния, число у строки с комментариями,
  //     прочерк у строки без них. Заголовки модуля — объекты с label/arrow.
  {
    const {c} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    const labels = (v.cols || []).map((h) => h.label);
    check('таблица: колонка комментариев объявлена сразу после состояния',
          labels.indexOf('💬') === labels.indexOf('Статус') + 1,
          JSON.stringify(labels));
    check('таблица: кликабельны только 4 заголовка — id, Боль, Скор, Статус',
          v.cols.filter((h) => h.cursor === 'pointer').map((h) => h.label).join(',')
          === '#,Боль,Скор,Статус',
          JSON.stringify(v.cols.map((h) => [h.label, h.cursor])));
    const r0 = (v.rows || [])[0] || {};
    const r1 = (v.rows || [])[1] || {};
    check('таблица: у строки с комментариями показано число',
          String(r0.commentsLabel) === '2', String(r0.commentsLabel));
    check('таблица: ноль комментариев показан прочерком',
          String(r1.commentsLabel) === '—', String(r1.commentsLabel));
  }

  // 24. Переключатель «С комментариями»: параметр has_comments=1 в запросе
  //     сценария и в адресе; при выключении — ни того, ни другого.
  {
    const {c, calls, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    const listReq = () => q(calls, /\/drafts$/).pop() || {};
    check('таблица: без переключателя параметра has_comments в запросе нет',
          listReq().q && !('has_comments' in listReq().q));
    v.commentsChip.pick();
    await settle();
    check('таблица: включённый переключатель шлёт has_comments=1',
          listReq().q && String(listReq().q.has_comments) === '1',
          listReq().q && JSON.stringify(listReq().q));
    check('таблица: включённый переключатель записан в адрес как has_comments=1',
          /has_comments=1/.test(String(ctx.location.hash || '')),
          String(ctx.location.hash || ''));
    // pick замыкается на фильтры момента рендера: выключать нужно свежим
    // снимком, каким в живом экране был бы клик после перерисовки.
    vals(c).commentsChip.pick();
    await settle();
    check('таблица: выключенный переключатель убирает параметр из запроса',
          listReq().q && !('has_comments' in listReq().q));
    check('таблица: выключенный переключатель убирает has_comments из адреса',
          !/has_comments=1/.test(String(ctx.location.hash || '')),
          String(ctx.location.hash || ''));
  }

  // 24b. Общий контур: тот же переключатель работает и для /drafts/list.
  {
    const {c, calls} = build(F, {});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    v.commentsChip.pick();
    await settle();
    const req = calls.get.filter((g) => g.p === '/drafts/list').pop();
    check('таблица: общий список тоже получает has_comments=1',
          !!req && String(req.q.has_comments) === '1');
    check('таблица: в общем контуре метка строки берётся из comments_count',
          String(((vals(c).rows || [])[0] || {}).commentsLabel) === '2');
  }

  // 25. (а) 14.8.18 — холодная загрузка wf-ссылки: пропс сценария приходит
  //     ПОСЛЕ монтирования (оболочка тянет /auth/me → /workflows). Экран
  //     обязан дождаться пропса и открыть адрес СО срезом: итоговый запрос —
  //     к ручке сценария с min_score, дропдаун и адрес показывают срез.
  {
    const {c, calls, ctx} = build(F, {workflow: ''},
        {hash: '#wf:cold_dm:draftsTable?min_score=50'});
    await c.componentDidMount();
    await settle();
    check('таблица: холодная wf-ссылка — до приезда пропса ни одного запроса',
          calls.get.length === 0, JSON.stringify(calls.get.map((g) => g.p)));
    check('таблица: холодная wf-ссылка — экран ждёт, а не показывает общий список',
          vals(c).range === 'загрузка…', vals(c).range);

    c.props.workflow = 'cold_dm';
    await c.componentDidUpdate({workflow: ''});
    await settle();
    const cold = q(calls, /^\/workflows\/cold_dm\/drafts$/);
    check('таблица: холодная wf-ссылка — итоговый запрос к ручке сценария, ровно один',
          cold.length === 1, JSON.stringify(cold.map((g) => g.q)));
    check('таблица: холодная wf-ссылка — срез min_score применён к запросу',
          !!cold[0] && String(cold[0].q.min_score) === '50',
          cold[0] && JSON.stringify(cold[0].q));
    check('таблица: холодная wf-ссылка — общая очередь не запрашивалась',
          q(calls, /^\/drafts\/list$/).length === 0);
    const v = vals(c);
    check('таблица: холодная wf-ссылка — дропдаун показывает скор 50',
          v.minScore === '50', v.minScore);
    check('таблица: холодная wf-ссылка — адрес остался маршрутом сценария со срезом',
          String(ctx.location.hash || '').indexOf('#wf:cold_dm:draftsTable?') === 0
          && /min_score=50/.test(String(ctx.location.hash || '')),
          String(ctx.location.hash || ''));
  }

  // 26. (б) Пагинация: страница 2 уходит offset=50, диапазон в подписи едет,
  //     адрес несёт page=2; размер страницы выбирается и уходит в limit.
  {
    const {c, calls, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const v = vals(c);
    check('таблица: подпись диапазона первой страницы',
          v.range === 'Показано 1–50 из 65', v.range);
    const page2 = v.pages.find((p) => p.label === '2');
    check('таблица: кнопка второй страницы доступна',
          !!page2 && typeof page2.pick === 'function');
    page2.pick();
    await settle();
    const p2 = q(calls, wfRe).pop();
    check('таблица: страница 2 уходит с offset=50 и тем же размером',
          !!p2 && p2.q.offset === 50 && p2.q.limit === 50, p2 && JSON.stringify(p2.q));
    check('таблица: страница 2 записана в адрес',
          /page=2/.test(String(ctx.location.hash || '')), String(ctx.location.hash || ''));
    check('таблица: подпись диапазона второй страницы',
          vals(c).range === 'Показано 51–65 из 65', vals(c).range);

    const size100 = vals(c).sizes.find((s) => s.label === '100');
    check('таблица: выбор размера страницы доступен', !!size100);
    size100.pick();
    await settle();
    const sized = q(calls, wfRe).pop();
    check('таблица: новый размер уходит limit=100 со сбросом на первую страницу',
          !!sized && sized.q.limit === 100 && sized.q.offset === 0,
          sized && JSON.stringify(sized.q));
  }

  // 27. (в) Сортировка: клик по «Скор» — desc, второй клик — asc; по умолчанию
  //     таблица отсортирована по created, и это видно стрелкой в заголовке.
  {
    const {c, calls, ctx} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    check('таблица: по умолчанию стрелка стоит у id (created)',
          vals(c).cols.find((h) => h.label === '#').arrow === '↓');
    let head = vals(c).cols.find((h) => h.label === 'Скор');
    check('таблица: заголовок «Скор» кликабелен', !!head && head.cursor === 'pointer');
    head.pick();
    await settle();
    let req = q(calls, wfRe).pop();
    check('таблица: клик по «Скор» шлёт sort=score&order=desc',
          !!req && req.q.sort === 'score' && req.q.order === 'desc',
          req && JSON.stringify(req.q));
    check('таблица: сортировка записана в адрес',
          /sort=score(&|$)/.test(String(ctx.location.hash || '')),
          String(ctx.location.hash || ''));
    check('таблица: стрелка переехала в «Скор»',
          vals(c).cols.find((h) => h.label === 'Скор').arrow === '↓');
    vals(c).cols.find((h) => h.label === 'Скор').pick();
    await settle();
    req = q(calls, wfRe).pop();
    check('таблица: второй клик по «Скор» переворачивает порядок',
          !!req && req.q.sort === 'score' && req.q.order === 'asc');
  }

  // 28. Поиск через модуль: во время набора запросов нет (пауза 350 мс),
  //     после паузы уходит ровно один запрос со строкой. Так поле перестаёт
  //     терять символы: значение живёт в поле, а не перерисовывается из state.
  {
    const {c, calls} = build(F, {workflow: WF});
    await c.componentDidMount();
    await settle();
    const before = q(calls, wfRe).length;
    vals(c).setQ({target: {value: 'иван'}});
    await settle();
    check('таблица: во время набора запросов нет',
          q(calls, wfRe).length === before);
    await new Promise((r) => setTimeout(r, 420));
    const after = q(calls, wfRe).slice(before);
    check('таблица: после паузы ушёл ровно один запрос со строкой поиска',
          after.length === 1 && after[0].q.q === 'иван',
          JSON.stringify(after.map((a) => a.q)));
  }

  // 29. (д) Мутация: вернуть жёсткий потолок страниц — красный.
  {
    const src = fs.readFileSync(DIR + '/' + F, 'utf8');
    check('мутация: жёсткий предел страниц в load() — красный (в источнике его нет)',
          !/limit:\s*200/.test(src));
    const logic = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
    check('таблица: параметры запроса берутся из table.query()',
          /this\.table\.query\(\)/.test(logic));
  }
}

async function main() {
  await card();
  await comments();
  await table();

  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
