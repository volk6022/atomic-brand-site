// Поведенческая проверка экрана «Подбор каналов» (волна И).
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики.
// Ни тот, ни другой не нажимает на кнопки. А здесь именно кнопки и важны:
// решения по кандидатам — это деньги (аккаунт вступает в чужой чат), и ошибка
// экрана стоит либо лишнего вступления, либо потерянного кандидата.
//
// Файл исполняет настоящую логику экрана под записывающим API и сверяет,
// ЧТО экран запросил, ЧТО нарисовал и ЧТО отправил по кнопкам. Значения —
// дословно из `api-fixtures.json`. Это контракт: правится экран, а не файл.
//
//   node check-discovery.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarDiscovery.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond, extra) { results.push([cond ? 'ok  ' : 'FAIL', extra ? name + ' — ' + extra : name]); }

const LIST = fixtures['/discovery/candidates'];
const QUERIES = fixtures['/discovery/queries'];
const OPTIONS = fixtures['/channels/options'];
const ACCOUNTS = fixtures['/accounts'];
const SCAN_ACK = fixtures['POST /discovery/scan'];
const DECIDE_ACK = fixtures['POST /discovery/candidates/{id}/decide'];
const CONNECT_ACK = fixtures['POST /channels'];

if (!LIST || !Array.isArray(LIST.rows) || !Array.isArray(LIST.states)) {
  console.error('нет образца GET /discovery/candidates со списком states. Пересними дампер или пополни api-fixtures.json');
  process.exit(2);
}
if (!QUERIES || !SCAN_ACK || !DECIDE_ACK || !CONNECT_ACK || !Array.isArray(OPTIONS) ||
    !Array.isArray(ACCOUNTS)) {
  console.error('нет образцов /discovery/queries, /channels/options, /accounts или POST-ключей §5.2. Возврати их в api-fixtures.json');
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
      if (p === '/discovery/candidates') return clone(opts.list || LIST);
      if (p === '/discovery/queries') {
        if (opts.failQueries) throw new Error(opts.failQueries);
        return clone(opts.queries || QUERIES);
      }
      if (p === '/channels/options') return clone(OPTIONS);
      if (p === '/accounts') return clone(ACCOUNTS);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => {
      calls.post.push({p: p, body: body || {}});
      if (opts.failDecide && p.indexOf('/decide') >= 0) throw new Error(opts.failDecide);
      if (opts.failScan && p === '/discovery/scan') throw new Error(opts.failScan);
      if (p === '/discovery/scan') return clone(Object.assign({}, SCAN_ACK, opts.scanAck || {}));
      if (/^\/discovery\/candidates\/\d+\/decide$/.test(p))
        return clone(Object.assign({}, DECIDE_ACK, opts.decideAck || {}));
      if (p === '/channels') return clone(Object.assign({}, CONNECT_ACK, opts.connectAck || {}));
      throw new Error('нет образца ответа для ' + p);
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

  // Роль приходит в api.role — её и подаём на стенд вместе с тостами.
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast:(t, c)=>__calls.toasts.push({t: t, c: c}), drill(){}, trace(){},
              go(){}, modal(){}, role: __role}, mobile:false}, {}); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__calls = calls;
  ctx.__role = opts.role;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const candGets = (calls) => calls.get.filter((g) => g.p === '/discovery/candidates');
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }

// Кандидат в решении `pending` — в фикстуре его нет (там один connected), стенд
// подставляет строку той же формы `_candidate_row`.
function pendingList() {
  const l = clone(LIST);
  l.rows = [{id:1, username:'fresh_chats', title:'Fresh chats', members:320,
             chat_type:null, source:'similar', seed_channel_id:2,
             liveness_posts_7d:12, liveness_comments_7d:3,
             liveness_checked_at:'2026-09-13T01:00:00+00:00',
             llm_verdict:'fit', llm_score:0.82, llm_reason:'тема совпадает с продуктом',
             llm_at:'2026-09-13T01:05:00+00:00',
             decision:'pending', decided_by:null, decided_at:null, decision_reason:null}];
  l.states = [{key:'pending', count:1}, {key:'approved', count:0},
              {key:'rejected', count:0}, {key:'connected', count:0}];
  l.total = 1;
  return l;
}

// Одобренный кандидат с username — POST-ответ фикстуры и есть такая строка.
function approvedList() {
  const l = clone(LIST);
  l.rows = [clone(DECIDE_ACK)];
  l.states = [{key:'pending', count:0}, {key:'approved', count:1},
              {key:'rejected', count:0}, {key:'connected', count:0}];
  l.total = 1;
  return l;
}

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {

  // 0. До загрузки экран обязан отдавать все дырки разметки — и НЕ показывать
  //    пустое состояние: «загружаю» и «пусто» — разные новости.
  {
    const {c} = build();
    const v = vals(c);
    check('renderVals() до загрузки не падает', !v.__err);
    check('до загрузки ключи разметки присутствуют',
          ['stateFilters', 'rows', 'cols', 'loading', 'hasError', 'errorMsg',
           'hasRows', 'isEmpty', 'emptyTitle', 'emptyNote', 'queries', 'queryCols',
           'queriesNote', 'seedOptions', 'scanKindOptions', 'canScan', 'scanning',
           'hasScanError', 'scanError', 'hasQueries', 'queriesEmpty',
           'hasQueriesError', 'queriesError'].every((k) => k in v));
    check('до загрузки пустое состояние не рисуется', v.isEmpty === false && v.hasRows === false);
  }

  // G-30. Чипсы состояний — из СПИСКА states: счётчик чипса по key, ключа в
  // списке нет — прочерк. Главная ловушка формы: у соседнего экрана states —
  // словарь, и скопированный оттуда код читает undefined.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();

    const first = candGets(calls)[0];
    check('G-30 первый запрос — GET /discovery/candidates с limit/offset, без фильтров',
          !!first && first.q.limit === 50 && first.q.offset === 0 &&
          !('state' in first.q) && !('source' in first.q) && !('verdict' in first.q),
          JSON.stringify(first && first.q));
    check('G-30 /discovery/queries и /channels/options запрослены при монтаже',
          calls.get.some((g) => g.p === '/discovery/queries') &&
          calls.get.some((g) => g.p === '/channels/options'));
    check('G-61 без роли /accounts не запрашивается (owner-ветка не срабатывает)',
          !calls.get.some((g) => g.p === '/accounts'));

    const v = vals(c);
    check('G-30 renderVals после загрузки не падает', !v.__err);
    check('G-30 чипсов ровно пять: «Все» и четыре состояния',
          v.stateFilters.length === 5, JSON.stringify(v.stateFilters.map((f) => f.label)));

    // Дословно: pending в фикстуре — count 0, connected — 1.
    const want = {pending:LIST.states.find((s) => s.key === 'pending').count,
                  approved:LIST.states.find((s) => s.key === 'approved').count,
                  rejected:LIST.states.find((s) => s.key === 'rejected').count,
                  connected:LIST.states.find((s) => s.key === 'connected').count};
    for (const k of Object.keys(want)) {
      const label = {pending:'на проверке', approved:'одобрен', rejected:'отклонён',
                     connected:'подключён'}[k];
      const chip = v.stateFilters.find((f) => f.label === label);
      check('G-30 счётчик чипса «' + k + '» = ' + want[k] + ' из списка states',
            !!chip && chip.count === '· ' + want[k],
            chip ? ('получено ' + JSON.stringify(chip.count)) : 'чипса нет');
    }
    check('G-30 ноль показывается нулём, а не спрятан (pending: 0)',
          v.stateFilters.some((f) => f.count === '· 0'));

    // Ключ пропал из списка — прочерк «—», а не ноль.
    const noPending = clone(LIST);
    noPending.states = LIST.states.filter((s) => s.key !== 'pending');
    const c2 = build({list: noPending}).c;
    await c2.componentDidMount();
    await sleep();
    check('G-30 состояние без элемента в states показано как «—», а не как 0',
          vals(c2).stateFilters.some((f) => f.count === '· —'));

    // rows[0] несёт username первого кандидата фикстуры (это читает smoke).
    check('G-30 rows[0] несёт username первого кандидата фикстуры дословно',
          v.rows.length === LIST.rows.length &&
          v.rows[0].username === LIST.rows[0].username,
          JSON.stringify(v.rows[0] && v.rows[0].username));
    check('G-3A подпись истории содержит per_run.queries из фикстуры (' +
          QUERIES.per_run.queries + ')',
          v.queriesNote.indexOf(String(QUERIES.per_run.queries)) >= 0,
          JSON.stringify(v.queriesNote));
  }

  // G-31. Фильтры уходят параметрами: чипс — state, селекты — source и
  // verdict, «Все»/пустые — параметра нет. Сортировка — только ключами из
  // sorts ответа.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    let v = vals(c);

    const chip = v.stateFilters.find((f) => f.label === 'одобрен');
    check('G-31 чипс состояния несёт обработчик', !!chip && typeof chip.pick === 'function');
    if (chip) { chip.pick(); await sleep(); }
    let g = candGets(calls)[1];
    check('G-31 чипс approved просит state=approved', !!g && g.q.state === 'approved');

    v = vals(c);
    const allChip = v.stateFilters.find((f) => f.label === 'Все');
    if (allChip) { allChip.pick(); await sleep(); }
    g = candGets(calls)[2];
    check('G-31 чипс «Все» убирает state из запроса', !!g && !('state' in g.q));

    v = vals(c);
    v.setSource({target: {value: 'similar'}});
    await sleep();
    g = candGets(calls)[3];
    check('G-31 селект источника шлёт source=similar', !!g && g.q.source === 'similar');

    v = vals(c);
    v.setVerdict({target: {value: 'fit'}});
    await sleep();
    g = candGets(calls)[4];
    check('G-31 селект вердикта шлёт verdict=fit', !!g && g.q.verdict === 'fit');

    // Сортировка: кликабельны только колонки, чей ключ сервер разрешил.
    v = vals(c);
    const headFound = v.cols.find((col) => col.label === 'Найден');
    const before = candGets(calls).length;
    if (headFound && typeof headFound.pick === 'function') { headFound.pick(); await sleep(); }
    g = candGets(calls)[candGets(calls).length - 1];
    check('G-31 клик по «Найден» сортирует created (ключ из sorts ответа), порядок перевернулся',
          candGets(calls).length === before + 1 && g.q.sort === 'created' &&
          g.q.order === 'asc',
          JSON.stringify(g && g.q));

    const headSrc = v.cols.find((col) => col.label === 'Источник');
    const before2 = candGets(calls).length;
    if (headSrc) headSrc.pick();
    await sleep();
    check('G-31 колонка вне sorts не кликается и запроса не делает',
          candGets(calls).length === before2 &&
          !candGets(calls).some((x) => x.q.sort === 'source'));

    // sorts приходит с ответом: усечённый список сужает и кликабельность.
    const shortSorts = clone(LIST);
    shortSorts.sorts = ['title'];
    const c2 = build({list: shortSorts}).c;
    await c2.componentDidMount();
    await sleep();
    const v2 = vals(c2);
    const headTitle = v2.cols.find((col) => col.label === 'Кандидат');
    const headMembers = v2.cols.find((col) => col.label === 'Участники');
    check('G-31 сортировки сужаются до sorts ответа (title кликается, members нет)',
          !!headTitle && headTitle.cursor === 'pointer' &&
          !!headMembers && headMembers.cursor === 'default');
  }

  // G-32. Пустое состояние: без фильтров — «скан не запускался», под
  // фильтром — «под фильтр ничего не подошло». Две разные новости.
  {
    const empty = {total:0, limit:50, offset:0, rows:[],
                   states:[{key:'pending', count:0}, {key:'approved', count:0},
                           {key:'rejected', count:0}, {key:'connected', count:0}],
                   sorts:['created', 'members', 'title']};
    const {c, calls} = build({list: empty});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('G-32 пустой список без фильтров — «Скан не запускался ни разу»',
          v.isEmpty === true && v.hasRows === false &&
          v.emptyTitle === 'Скан не запускался ни разу');
    check('G-32 к пустоте приложен призыв запустить скан',
          v.emptyNote.indexOf('Запустите скан или подождите расписания') >= 0);

    const chip = v.stateFilters.find((f) => f.label === 'одобрен');
    if (chip) { chip.pick(); await sleep(); }
    v = vals(c);
    check('G-32 пустота под фильтром не выдаёт себя за «скан не запускался»',
          v.isEmpty === true && v.emptyTitle === 'Под фильтр ничего не подошло');
  }

  // G-33. Одобрение: сразу POST с телом {decision:'approved'}, строка
  // обновляется из ответа, список не перечитывается.
  {
    const {c, calls} = build({role: 'owner', list: pendingList()});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    const row = v.rows.find((r) => r.canApprove);
    check('G-33 у pending-кандидата есть кнопка «Одобрить»',
          !!row && typeof row.approve === 'function');
    const before = candGets(calls).length;
    if (row) { row.approve(); await sleep(); }

    const posts = calls.post.filter((p) => p.p === '/discovery/candidates/1/decide');
    check('G-33 POST /discovery/candidates/{id}/decide ровно один, тело {decision:"approved"}',
          posts.length === 1 && JSON.stringify(posts[0].body) === JSON.stringify({decision:'approved'}),
          JSON.stringify(posts[0] && posts[0].body));
    // Ответ фикстуры: decision approved, decided_by owner@local.
    v = vals(c);
    const after = v.rows.find((r) => r.id === 1);
    check('G-33 строка обновлена из ответа: бейдж «одобрен», decided_by из ответа',
          !!after && after.decisionLabel === 'одобрен' &&
          after.decidedBy === DECIDE_ACK.decided_by);
    check('G-33 список не перечитан (второго GET /discovery/candidates нет)',
          candGets(calls).length === before);
    check('G-33 об успехе сказано тостом', calls.toasts.length === 1);
  }

  // G-34. Отклонение: форма причины встроена в строку, пустая причина кнопку
  // не отпускает, POST несёт reason, причина показывается из ответа.
  {
    const {c, calls} = build({role: 'owner', list: pendingList(),
                              decideAck: {decision:'rejected',
                                          decision_reason:'чат не по теме'}});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    const row = v.rows.find((r) => r.canReject);
    check('G-34 у pending-кандидата есть кнопка «Отклонить…»',
          !!row && typeof row.rejectToggle === 'function');
    if (row) { row.rejectToggle(); await sleep(); }
    v = vals(c);
    const open = v.rows.find((r) => r.rejectOpen);
    check('G-34 форма причины открыта, кнопка при пустой причине неактивна',
          !!open && open.rejectDisabled === true);
    if (open) { open.rejectSubmit(); await sleep(); }
    check('G-34 с пустой причиной POST не уходит', calls.post.length === 0);

    v = vals(c);
    const opened = v.rows.find((r) => r.rejectOpen);
    if (opened) { opened.setReason({target: {value: 'чат не по теме'}}); await sleep(); }
    const filled = vals(c).rows.find((r) => r.rejectOpen);
    check('G-34 введённая причина активирует кнопку', !!filled && filled.rejectDisabled === false);
    if (filled) { filled.rejectSubmit(); await sleep(); }

    const posts = calls.post.filter((p) => p.p === '/discovery/candidates/1/decide');
    check('G-34 POST с телом {decision:"rejected", reason:"<текст>"}',
          posts.length === 1 &&
          JSON.stringify(posts[0].body) === JSON.stringify({decision:'rejected', reason:'чат не по теме'}),
          JSON.stringify(posts[0] && posts[0].body));
    const after = vals(c).rows.find((r) => r.id === 1);
    check('G-34 причина показана в строке (decision_reason из ответа)',
          !!after && after.decisionReason === 'чат не по теме');
  }

  // G-35. Серверские отказы (409 «уже подключён», 422) — тост с текстом
  // detail, экран жив.
  {
    const {c, calls} = build({role: 'owner', list: pendingList(),
                              failDecide: 'кандидат уже подключён'});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const row = v.rows.find((r) => r.canApprove);
    if (row) { row.approve(); await sleep(); }
    check('G-35 отказ решения показан текстом сервера красным тостом',
          calls.toasts.some((t) => t.c === '#DA501C' &&
            /кандидат уже подключён/.test(t.t)),
          JSON.stringify(calls.toasts));
    check('G-35 после отказа экран жив: renderVals не падает, строка на месте',
          !vals(c).__err && vals(c).rows.length === 1);
  }

  // G-36. Кнопки по праву: reviewer видит список, но не видит ни одной кнопки.
  {
    const {c, calls} = build({role: 'reviewer', list: approvedList()});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-36 reviewer видит список кандидатов', !v.__err && v.rows.length === 1);
    check('G-36 у reviewer нет кнопок решений/скана/подключения',
          v.canScan === false &&
          v.rows.every((r) => !r.canApprove && !r.canReject && !r.canConnect),
          JSON.stringify([v.canScan, v.rows.map((r) => [r.canApprove, r.canReject, r.canConnect])]));
    check('G-36 у reviewer не запрашивается /accounts',
          !calls.get.some((g) => g.p === '/accounts'));
    check('G-36 reviewer не отправляет POST вовсе', calls.post.length === 0);
  }

  // G-37. Скан «похожие»: семя из /channels/options (это каналы), POST без
  // account_id, тост с номером задачи.
  {
    const {c, calls} = build({role: 'owner', list: pendingList()});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('G-37 селект семени наполнен из /channels/options: первый — DevOps Chat',
          v.seedOptions.length === OPTIONS.length &&
          v.seedOptions[0].label === OPTIONS[0].title,
          JSON.stringify(v.seedOptions.slice(0, 2)));
    check('G-37 семя по умолчанию — первый канал из списка',
          v.scanSeed === String(OPTIONS[0].id));

    v.scanSubmit();
    await sleep();
    const posts = calls.post.filter((p) => p.p === '/discovery/scan');
    check('G-37 POST /discovery/scan с телом {kind:"similar", seed_channel_id:2}',
          posts.length === 1 &&
          JSON.stringify(posts[0].body) === JSON.stringify({kind:'similar', seed_channel_id:2}),
          JSON.stringify(posts[0] && posts[0].body));
    check('G-37 account_id в теле НЕТ (аккаунт выбирает сервер)',
          posts.length === 1 && !('account_id' in posts[0].body));
    check('G-37 тост «Поиск запущен · задача #' + SCAN_ACK.run_id + ' — ход виден в Runs»',
          calls.toasts.some((t) => t.t === 'Поиск запущен · задача #' + SCAN_ACK.run_id +
            ' — ход виден в Runs' && t.c === '#156479'),
          JSON.stringify(calls.toasts));
    check('G-37 после запуска экран не остался в состоянии «отправляю»',
          vals(c).scanning === false);
  }

  // G-38. Скан «по строке»: пустая и 256 символов не отправляются, валидная —
  // отправляется.
  {
    const {c, calls} = build({role: 'owner'});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    v.setScanKind({target: {value: 'search'}});
    await sleep();

    v = vals(c);
    check('G-38 переключение вида скрыло селект семени и открыло строку',
          v.scanSearch === true && v.scanSimilar === false);
    v.scanSubmit();
    await sleep();
    check('G-38 пустая строка — POST нет, на экране объяснение',
          calls.post.length === 0 && vals(c).hasScanError === true);

    v = vals(c);
    v.setScanQuery({target: {value: 'х'.repeat(256)}});
    await sleep();
    v = vals(c);
    v.scanSubmit();
    await sleep();
    check('G-38 строка из 256 символов — POST нет (граница 255), объяснение упомяняет 255',
          calls.post.length === 0 && /255/.test(vals(c).scanError),
          JSON.stringify(vals(c).scanError));

    v = vals(c);
    v.setScanQuery({target: {value: 'devops чаты'}});
    await sleep();
    vals(c).scanSubmit();
    await sleep();
    const posts = calls.post.filter((p) => p.p === '/discovery/scan');
    check('G-38 валидная строка — POST {kind:"search", query:"…"} ровно один',
          posts.length === 1 &&
          JSON.stringify(posts[0].body) === JSON.stringify({kind:'search', query:'devops чаты'}),
          JSON.stringify(posts[0] && posts[0].body));
    check('G-38 после успешной отправки объяснение снято',
          vals(c).hasScanError === false);
  }

  // G-35 (скан). Отказ скана (409 «уже искали сегодня») — текст сервера.
  {
    const {c, calls} = build({role: 'owner', failScan: 'сегодня уже искали — приходите завтра'});
    await c.componentDidMount();
    await sleep();
    vals(c).scanSubmit();
    await sleep();
    check('G-35 отказ скана показан текстом сервера красным тостом',
          calls.toasts.some((t) => t.c === '#DA501C' &&
            /сегодня уже искали/.test(t.t)),
          JSON.stringify(calls.toasts));
  }

  // G-39. Подключение: customer кнопки не видит и /accounts не зовёт; owner
  // получает активные аккаунты, POST без «@», тост с note из ответа.
  {
    const {c: cc, calls: cust} = build({role: 'customer', list: approvedList()});
    await cc.componentDidMount();
    await sleep();
    let v = vals(cc);
    check('G-39 у customer на approved-кандидате кнопки «Подключить» нет',
          v.rows.every((r) => r.canConnect === false),
          JSON.stringify(v.rows.map((r) => r.canConnect)));
    check('G-39 customer не запрашивает /accounts (Fleet закрыт)',
          !cust.get.some((g) => g.p === '/accounts'));
    check('G-39 customer ничего не отправляет', cust.post.length === 0);

    const {c, calls} = build({role: 'owner', list: approvedList()});
    await c.componentDidMount();
    await sleep();
    check('G-39 владелец запрашивает /accounts при монтаже',
          calls.get.some((g) => g.p === '/accounts'));
    v = vals(c);
    const row = v.rows.find((r) => r.canConnect);
    check('G-39 у owner на approved с username есть кнопка «Подключить»',
          !!row && typeof row.connectToggle === 'function');
    check('G-39 селект аккаунтов — только активные (id 12 есть, warmup 13 нет)',
          !!row && row.accountOptions.length === 1 &&
          row.accountOptions[0].value === '12' &&
          !row.accountOptions.some((a) => a.value === '13'),
          JSON.stringify(row && row.accountOptions));
    if (row) { row.connectToggle(); await sleep(); }
    v = vals(c);
    const open = v.rows.find((r) => r.connectOpen);
    check('G-39 форма подключения открыта, дефолт — первый активный (12)',
          !!open && String(open.connectAccount) === '12');
    if (open) { open.connectSubmit(); await sleep(); }
    const posts = calls.post.filter((p) => p.p === '/channels');
    check('G-39 POST /channels {username без @, engage_account_id:12}',
          posts.length === 1 &&
          JSON.stringify(posts[0].body) === JSON.stringify({username:'vpsclub', engage_account_id:12}),
          JSON.stringify(posts[0] && posts[0].body));
    check('G-39 тост несёт note из ответа («' + CONNECT_ACK.note + '»)',
          calls.toasts.some((t) => t.t.indexOf(CONNECT_ACK.note) >= 0),
          JSON.stringify(calls.toasts));
  }

  // G-3A. История поисков: строки из фикстуры дословно, подпись с per_run,
  // порядок серверный — сортировок у таблицы нет.
  {
    const qs = {total:2, limit:50, offset:0, per_run:{queries:5},
                rows:[{id:11, kind:'similar', seed_channel_id:2, query:null,
                       account_id:12, run_id:3, found_total:7, new_total:5,
                       created_at:'2026-09-13T02:30:39+00:00'},
                      {id:12, kind:'search', seed_channel_id:null, query:'devops',
                       account_id:12, run_id:3, found_total:4, new_total:2,
                       created_at:'2026-09-13T02:31:40+00:00'}]};
    const {c, calls} = build({queries: qs});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const qget = calls.get.find((g) => g.p === '/discovery/queries');
    check('G-3A история запрошена без сортировки (ручка её не имеет)',
          !!qget && !('sort' in qget.q) && !('order' in qget.q),
          JSON.stringify(qget && qget.q));
    check('G-3A две строки истории — по числу rows фикстуры',
          v.hasQueries === true && v.queries.length === 2);
    check('G-3A первая строка дословно: семя канал #2, прогон #3, найдено 7, новых 5',
          v.queries[0].seed === 'канал #2' && v.queries[0].run === '#3' &&
          v.queries[0].found === 7 && v.queries[0].fresh === 5 &&
          v.queries[0].account === 'acc-12');
    check('G-3A вторая строка: текст запроса и вид без перевода в чужой словарь',
          v.queries[1].query === 'devops' && v.queries[1].kind === 'поиск');
    check('G-3A подпись содержит per_run.queries (5)',
          v.queriesNote.indexOf('5') >= 0, JSON.stringify(v.queriesNote));
  }

  // G-2A-подобная страховка истории: отказ /discovery/queries не роняет экран
  // и показывается своим текстом.
  {
    const {c} = build({failQueries: 'история поисков недоступна'});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-3A отказ истории не роняет кандидатов и показан своим текстом',
          !v.__err && v.hasQueriesError === true &&
          v.queriesError === 'история поисков недоступна' && v.rows.length === LIST.rows.length,
          JSON.stringify([v.hasQueriesError, v.queriesError]));
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
