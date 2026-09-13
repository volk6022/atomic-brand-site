// Поведенческая проверка экрана «Channels» — волна К3 (TESTS-autoflow-gui.md,
// блок Е: G-40…G-43). Образец стенда — check-backfill.js: файл исполняет
// настоящую логику экрана под записывающим api и сверяет, ЧТО экран запросил,
// ЧТО нарисовал в строках и карточке и КОГДА перечитал список.
//
//   node check-channels.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarChannels.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const LIST = fixtures['/channels'];
const SUMMARY = fixtures['/channels/discussions'];
// Дырки в образце — стоп: экран против выдумки не проверяем (см. smoke-dc.js).
if (!LIST || !Array.isArray(LIST.rows) || LIST.rows.length < 2) {
  console.error('нет образца GET /channels минимум с 2 строками — пересними дампер');
  process.exit(2);
}
if (!LIST.rows.some((r) => r.source === 'discovery') ||
    !LIST.rows.some((r) => !r.source) ||
    !LIST.rows.some((r) => r.discovery_seed === true) ||
    !LIST.rows.some((r) => r.discovery_seed === false)) {
  console.error('в образце /channels нет строк с source:discovery/null и discovery_seed:true/false — волна Е не доснята');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], patch: [], del: [], toasts: [], drills: [], posts: []};
  // Ручное «открывашка» для перечита: holdNext заставляет СЛЕДУЮЩИЙ get зависнуть
  // до release() — между ответом PATCH и перечитом нужно окно, чтобы увидеть,
  // что строку обновил именно ответ ручки, а не загрузка списка.
  let holdNext = false, releaseGet = null;
  const held = () => holdNext
    ? new Promise((r) => { holdNext = false; releaseGet = r; })
    : Promise.resolve();

  const api = {
    role: opts.role || 'owner',
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      await held();
      // G-41: карточка строится из уже загруженной строки, второй запрос не
      // заводим — стенд принципиально не знает других путей и ругается.
      if (p === '/channels') return clone(opts.list || LIST);
      if (p === '/channels/discussions') return clone(opts.summary || SUMMARY);
      throw new Error('нет образца ответа для ' + p);
    },
    patch: async (p, body) => {
      calls.patch.push({p: p, body: body});
      if (opts.failPatch) throw new Error('роль «viewer» не может менять донора');
      // Ответ ручки адресует строку: id берём из пути — иначе проверка «строку
      // обновил ответ PATCH» теряла бы смысл на неподходящем id.
      const id = Number(String(p).split('/').filter(Boolean).pop());
      return clone(opts.patchReply ||
        {id: id, ingest_enabled: true,
         l1_bypass_enabled: false, discovery_seed: true});
    },
    post: async (p) => { calls.posts.push({p: p}); return {ok: true}; },
    del: async (p) => { calls.del.push({p: p}); return {ok: true}; },
    describe: (e) => (e && e.message) ? String(e.message) : String(e),
    isUnauthorized: () => false,
    isForbidden: () => false,
    toast: (t, c) => calls.toasts.push({t: t, c: c}),
    drill: (payload) => calls.drills.push(payload),
    modal() {}, go() {}, trace() {},
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
      constructor(){ this.props = {api: __api, mobile: false}; }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__api = api;
  ctx.__calls = calls;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls, api: api,
          hold: () => { holdNext = true; },
          release: () => { if (releaseGet) { const r = releaseGet; releaseGet = null; r(); } }};
}

const sleep = () => new Promise((r) => setTimeout(r, 40));
const listGets = (calls) => calls.get.filter((g) => g.p === '/channels');
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }
const byId = (rows, id) => rows.find((r) => r.id === id);
const donorRow = (drill) => (drill.rows || []).find((x) => x.k === 'Донор подбора');
const donorActions = (drill) => (drill.actions || [])
  .filter((a) => a && (a.label === 'Сделать донором' || a.label === 'Убрать донора'));

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {
  const SRC_ROW = LIST.rows.find((r) => r.source === 'discovery');
  const PLAIN_ROW = LIST.rows.find((r) => !r.source);
  const SEED_ROW = LIST.rows.find((r) => r.discovery_seed === true);
  const NOSEED_ROW = LIST.rows.find((r) => r.discovery_seed === false);

  // 1. До загрузки renderVals() отдаёт полный набор дырок — отсутствие ключа не
  //    падает, а молча оставляет пустую ячейку, поэтому проверяем состав заранее.
  {
    const {c} = build();
    const v = vals(c);
    check('renderVals() до загрузки не падает', !v.__err);
    check('до загрузки ключи разметки присутствуют',
          ['rows', 'cols', 'discChips', 'chatTypes', 'summary', 'sizes', 'pages',
           'bfSubmit', 'addSubmit', 'reload']
            .every((k) => k in v));
  }

  // G-40. Бейдж «от подбора» — только у source:'discovery', остальным «—».
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('renderVals после загрузки не падает', !v.__err);

    const src = byId(v.rows, SRC_ROW.id);
    check('строке с source:"discovery" показан бейдж «от подбора»',
          !!src && src.srcBadge === 'от подбора' && src.noSource === false);
    check('мобильная карточка канала из подбора называет источник',
          !!src && src.srcMobile === 'от подбора');

    const plain = byId(v.rows, PLAIN_ROW.id);
    check('строке без source показан прочерк, бейджа нет',
          !!plain && plain.srcBadge === '' && plain.noSource === true &&
          plain.srcMobile === '—');

    // Бейдж — про источник, не про подписанта: поле другое (CONTRACT §4.3).
    check('бейдж завязан на source, а не на subscribed_by',
          v.rows.every((r) => (r.srcBadge === 'от подбора') ===
            ((LIST.rows.find((x) => x.id === r.id) || {}).source === 'discovery')));

    // Мутация стенда: manual/join тоже прочерк — бейдж только у discovery.
    const other = clone(LIST);
    other.rows[0].source = 'manual';
    other.rows[1].source = 'join';
    const c2 = build({list: other}).c;
    await c2.componentDidMount();
    await sleep();
    const v2 = vals(c2);
    check('source:"manual" и "join" — бейджа нет, прочерк',
          byId(v2.rows, other.rows[0].id).srcBadge === '' &&
          byId(v2.rows, other.rows[1].id).noSource === true);
  }

  // G-41. Донор подбора в карточке — из уже загруженной строки, без второго запроса.
  {
    const {c, calls, api} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);

    const seeded = byId(v.rows, SEED_ROW.id);
    seeded.open();
    await sleep();
    const d1 = calls.drills[calls.drills.length - 1];
    check('донор с флагом true — в карточке «Донор подбора: да»',
          !!donorRow(d1) && donorRow(d1).v === 'да');

    const unseeded = byId(v.rows, NOSEED_ROW.id);
    unseeded.open();
    await sleep();
    const d2 = calls.drills[calls.drills.length - 1];
    check('донор с флагом false — в карточке «Донор подбора: нет»',
          !!donorRow(d2) && donorRow(d2).v === 'нет');

    check('открытие карточки не делает запросов (drill из загруженной строки)',
          listGets(calls).length === 1 && calls.get.length === 2);

    // Стенд по умолчанию не знает других путей: лишний GET на карточку упал бы.
    const strict = await api.get('/channels/123').then(
      () => false, (e) => /нет образца ответа/.test(e.message));
    check('стенд ругается на GET кроме /channels и /channels/discussions', strict);

    // Мутация стенда: поля нет — строки в карточке тоже нет (не «нет» за сервер).
    const noField = clone(LIST);
    delete noField.rows.find((r) => r.id === SEED_ROW.id).discovery_seed;
    const b2 = build({list: noField});
    await b2.c.componentDidMount();
    await sleep();
    byId(vals(b2.c).rows, SEED_ROW.id).open();
    await sleep();
    const d3 = b2.calls.drills[b2.calls.drills.length - 1];
    check('без поля discovery_seed строки «Донор подбора» в карточке нет',
          b2.calls.drills.length === 1 && !donorRow(d3));
  }

  // G-42. Переключение донора: PATCH /channels/{id} c {discovery_seed}, тост,
  //       строка обновлена ответом, список перечитан. У reviewer действия нет.
  {
    // owner: «Сделать донором» на строке без флага.
    const {c, calls, hold, release} = build({role: 'owner'});
    await c.componentDidMount();
    await sleep();
    const seeded = byId(vals(c).rows, NOSEED_ROW.id);
    seeded.open();
    const d = calls.drills[calls.drills.length - 1];
    const act = donorActions(d).find((a) => a.label === 'Сделать донором');
    check('у владельца на недоноре есть действие «Сделать донором»', !!act);

    hold();               // следующий get зависнет: увидим окно после PATCH
    act.run();
    await sleep();
    const patchCall = calls.patch[calls.patch.length - 1];
    check('переключение зовёт PATCH /channels/{id} ровно с {discovery_seed:true}',
          calls.patch.length === 1 &&
          patchCall.p === '/channels/' + NOSEED_ROW.id &&
          JSON.stringify(patchCall.body) === JSON.stringify({discovery_seed: true}));
    check('после ответа сказано тостом', calls.toasts.some((t) => /донор/.test(t.t)));
    // Ответ ручки {id, ingest_enabled, l1_bypass_enabled, discovery_seed} применён
    // к строке: source ответ не несёт, поэтому видимая примета обновления — флаг
    // донора в карточке и само действие-переключатель, ещё ДО перечита списка.
    const vNow = vals(c);
    byId(vNow.rows, NOSEED_ROW.id).open();
    const dNow = calls.drills[calls.drills.length - 1];
    check('строку обновил ответ PATCH (в карточке «да», действие сменилось до перечита)',
          !!donorRow(dNow) && donorRow(dNow).v === 'да' &&
          donorActions(dNow).some((a) => a.label === 'Убрать донора'));
    release();
    await sleep();
    check('после ответа список перечитан (this.load())',
          listGets(calls).length === 2);

    // «Убрать донора» на строке с флагом.
    const {c: c3, calls: calls3} = build({role: 'owner',
      patchReply: {id: SEED_ROW.id, ingest_enabled: true,
                   l1_bypass_enabled: false, discovery_seed: false}});
    await c3.componentDidMount();
    await sleep();
    byId(vals(c3).rows, SEED_ROW.id).open();
    const act3 = donorActions(calls3.drills[calls3.drills.length - 1])
      .find((a) => a.label === 'Убрать донора');
    check('у владельца на доноре есть действие «Убрать донора»', !!act3);
    act3.run();
    await sleep();
    check('снятие донора зовёт PATCH с {discovery_seed:false}',
          calls3.patch.length === 1 &&
          calls3.patch[0].p === '/channels/' + SEED_ROW.id &&
          JSON.stringify(calls3.patch[0].body) === JSON.stringify({discovery_seed: false}));
  }

  // G-42. Право CHANNEL_EDIT: owner и customer — кнопка, reviewer — только строка.
  for (const role of ['owner', 'customer', 'reviewer']) {
    const {c, calls} = build({role: role});
    await c.componentDidMount();
    await sleep();
    byId(vals(c).rows, NOSEED_ROW.id).open();
    const d = calls.drills[calls.drills.length - 1];
    const acts = donorActions(d);
    check('роль ' + role + ': ' +
          (role === 'reviewer'
            ? 'действий донора нет, строка «Донор подбора» есть'
            : 'действие донора в карточке есть'),
          role === 'reviewer'
            ? acts.length === 0 && !!donorRow(d)
            : acts.length === 1);
  }

  // G-43. Существующее не сломано: чипсы, потолки формы, права кнопок.
  {
    const {c, calls} = build({role: 'owner'});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);

    check('чипсов обсуждения по-прежнему шесть: «Все» и пять состояний',
          v.discChips.length === 6);
    const unknownChip = v.discChips.find((f) => f.label === 'не проверяли');
    check('счётчик чипса сходится со сводкой (unknown: ' + SUMMARY.unknown + ')',
          !!unknownChip && unknownChip.count === '· ' + SUMMARY.unknown);
    const liveChip = v.discChips.find((f) => f.label === 'читаем');
    check('ноль в сводке показан нулём (live: 0)',
          !!liveChip && liveChip.count === '· 0');

    // Потолки формы «Дочитать всем»: 2000 сообщений / 30 дней — серверные,
    // экран повторяет их в отказе ввода и не зовёт ручку.
    c.setState({bfTarget: '5000'});
    await c.bfSubmit();
    check('цель больше 2000 отвергнута текстом с потолком, без POST',
          /2000/.test(c.state.bfError) && calls.posts.length === 0);
    c.setState({bfTarget: '2000', bfDepth: '40'});
    await c.bfSubmit();
    check('глубина больше 30 отвергнута текстом с потолком, без POST',
          /30/.test(c.state.bfError) && calls.posts.length === 0);
  }

  // G-43. canJoin/canAdd — прежняя развязка ролей.
  for (const role of ['owner', 'customer', 'reviewer']) {
    const {c} = build({role: role});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('роль ' + role + ': canJoin=' + (role === 'owner') +
          ', canAdd=' + (role === 'owner' || role === 'customer'),
          v.canJoin === (role === 'owner') &&
          v.canAdd === (role === 'owner' || role === 'customer'));
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
