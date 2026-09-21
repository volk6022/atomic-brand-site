// Поведенческая проверка трёх экранов Intel: «Ключ Intel» (D1), «Новая пачка»
// (D1), «Пачки и ревью» (D2) — проверки N1–N10 из §4.3 контракта
// _CONTRACT-intel-gui.md.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики
// (но не нажимает кнопки). Здесь нажимаются именно кнопки: у Intel это деньги
// и квота — запуск пачек, отмена, решение ревью. Файл исполняет настоящую
// логику экранов под записывающим API и сверяет, ЧТО экран запросил, ЧТО
// нарисовал и ЧТО отправил. Значения — дословно из `api-fixtures.json`
// (формы §1 контракта). Это контракт: правится экран, а не файл.
//
// Особенности стенда против check-discovery.js:
//   • `fetch` в песочнице — «Ключ Intel» шлёт PUT глобальным fetch (put в
//     radar-api.js нет), а `__imp` для './radar-api.js' отдаёт, кроме ручек,
//     `API` и `ApiError` — их putJson достаёт из модуля (примечание D1 к N2);
//   • `modal` и `go` пишут журналы — отмена пачки и переход после 202;
//   • таймер опроса — РЕАЛЬНЫЙ setTimeout: интервал вынесен в поле POLL_MS,
//     проверка ставит малый и ждёт тики (см. N6);
//   • setState зовёт componentDidUpdate (как рантайм support.js:914) — так
//     проверяется запись Markdown в #intelMd (N-md1/N-md2); `document`
//     песочницы отдаёт фейковый узел #intelMd с innerHTML;
//   • md.js подключён как radar-table.js (снятие export + await import →
//     __imp), а marked/purify — реальные файлы vendor/, свёрнутые в
//     фабрику-модуль (export{…} → присваивание): vm.SourceTextModule без
//     флага недоступен. Реальный DOMPurify без window возвращается из фабрики
//     рано, без sanitize/addHook и с isSupported:false, — для песочницы его
//     заменяет заглушка с тем же контрактом (см. makePurifyStub);
//   • мутации заглушек: st.batch/status и fail*-поля меняются между шагами —
//     проверки обязаны краснеть, если экран сломан.
//
//   node check-intel.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');
const mdSrc = fs.readFileSync(DIR + '/md.js', 'utf8')
  .replace(/^export /gm, '')
  .replace(/await import\(/g, 'await __imp(');

// ESM-файл → фабрика модуля: снимаем единственный `export {…};` в конце и
// возвращаем нужные имена через __exports. strict — как у настоящего ESM.
function esmViaExports(src, tail) {
  const body = src.replace(/^export\s*\{[\s\S]*?\};\s*$/m, '');
  if (body === src) throw new Error('export-блок не найден');
  return new Function('__exports', '"use strict";\n' + body + '\n;' + tail + '\n;return __exports;');
}

// marked 15 — реальный vendor-файл; DOM ему не нужен.
const MARKED_NS = esmViaExports(
  fs.readFileSync(DIR + '/../vendor/marked.esm.js', 'utf8'),
  '__exports.marked = marked; __exports.parse = parse;')({});

// DOMPurify 3.2.6 — реальный vendor-файл. В Node (нет window) фабрика
// возвращает объект без методов: sanitize тут не работает в принципе.
const REAL_PURIFY = esmViaExports(
  fs.readFileSync(DIR + '/../vendor/purify.es.js', 'utf8'),
  '__exports.default = purify;')({}).default;

// Заглушка с тем же контрактом, что у md.js: addHook('afterSanitizeAttributes'),
// sanitize(html, {USE_PROFILES}) — срезает on*-обработчики и javascript:/vbscript:-URL
// у href/src, применяет хуки к <a>/<area> (target/rel из md.js). Это проверка
// проводки экрана и md.js; настоящую санитизацию в браузере делает
// неизменённый vendor/purify.es.js (там getGlobal() даёт настоящий window).
function makePurifyStub() {
  const hooks = {afterSanitizeAttributes: []};
  const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const UNSAFE_URL = /^(?:javascript|vbscript)\s*:/i;
  const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction'];
  const applyHooks = (tag, attrs) => {
    if (tag !== 'a' && tag !== 'area') return attrs;
    const node = {
      tagName: tag.toUpperCase(),
      setAttribute(n, v) {
        const a = String(n).toLowerCase() + '="' + String(v).replace(/"/g, '&quot;') + '"';
        const i = attrs.findIndex((x) => x.toLowerCase().startsWith(String(n).toLowerCase() + '='));
        if (i >= 0) attrs[i] = a; else attrs.push(a);
      },
    };
    for (const h of hooks.afterSanitizeAttributes) h(node);
    return attrs;
  };
  const sanitize = (html) => String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(\/?)\s*([a-zA-Z][-\w]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g,
      (whole, slash, rawTag, rawAttrs) => {
        const tag = rawTag.toLowerCase();
        if (slash || tag === 'script') return tag === 'script' ? '' : '</' + tag + '>';
        const kept = [];
        rawAttrs.replace(ATTR, (raw, name, dq, sq, uq) => {
          const n = name.toLowerCase();
          const v = dq !== undefined ? dq : (sq !== undefined ? sq : (uq !== undefined ? uq : ''));
          if (n.startsWith('on')) return '';
          if (URL_ATTRS.indexOf(n) !== -1 && UNSAFE_URL.test(v.trim())) return '';
          kept.push(raw);
          return '';
        });
        const selfClose = /\/\s*$/.test(rawAttrs);
        const finalAttrs = applyHooks(tag, kept);
        return '<' + tag + (finalAttrs.length ? ' ' + finalAttrs.join(' ') : '') + (selfClose ? ' />' : '>');
      });
  return {
    isSupported: false,
    addHook: (entryPoint, fn) => { if (hooks[entryPoint]) hooks[entryPoint].push(fn); },
    sanitize,
  };
}

const PURIFY = REAL_PURIFY.isSupported ? REAL_PURIFY : makePurifyStub();

const SCREENS = {key: 'RadarIntelKey.dc.html',
                 batch: 'RadarIntelBatch.dc.html',
                 review: 'RadarIntelReview.dc.html'};
const logicOf = {};
for (const [k, f] of Object.entries(SCREENS)) {
  const src = fs.readFileSync(DIR + '/' + f, 'utf8');
  logicOf[k] = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
}

const results = [];
function check(name, cond, extra) { results.push([cond ? 'ok  ' : 'FAIL', extra ? name + ' — ' + extra : name]); }

const KEY = fixtures['/intel/key'];
const PUT_KEY = fixtures['PUT /intel/key'];
const VALIDATE_ACK = fixtures['POST /intel/batches/validate'];
const START_ACK = fixtures['POST /intel/batches'];
const LIST = fixtures['/intel/batches'];
const DETAIL = fixtures['/intel/batches/{id}'];
const DETAIL_FAILED = fixtures['/intel/batches/{id}-run-failed'];
const CANCEL_ACK = fixtures['POST /intel/batches/{id}/cancel'];
const RESUME_ACK = fixtures['POST /intel/batches/{id}/resume'];
const ITEMS = fixtures['/intel/batches/{id}/items'];
const CARD = fixtures['/intel/items/{id}'];
const CARD_FAILED = fixtures['/intel/items/{id}-failed'];
const CARD_MD = fixtures['/intel/items/{id}-md'];
const CARD_MD_XSS = fixtures['/intel/items/{id}-md-xss'];
const PATCH_ACK = fixtures['PATCH /intel/items/{id}'];
const KEY_EMPTY = fixtures['/intel/key-unconfigured'];

if (!KEY || !PUT_KEY || !VALIDATE_ACK || !START_ACK || !LIST ||
    !Array.isArray(LIST.rows) || !DETAIL || !CANCEL_ACK || !RESUME_ACK ||
    !DETAIL_FAILED ||
    !ITEMS || !Array.isArray(ITEMS.rows) || !CARD || !PATCH_ACK ||
    !CARD_FAILED || !KEY_EMPTY || !CARD_MD ||
    !CARD_MD_XSS || typeof CARD_MD_XSS.output !== 'string') {
  console.error('нет образцов Intel в api-fixtures.json (§4.1): /intel/key, PUT /intel/key, POST /intel/batches/validate, POST /intel/batches, /intel/batches, /intel/batches/{id}, /intel/batches/{id}-run-failed, POST /intel/batches/{id}/cancel, POST /intel/batches/{id}/resume, /intel/batches/{id}/items, /intel/items/{id}, PATCH /intel/items/{id}, /intel/items/{id}-failed, /intel/key-unconfigured, /intel/items/{id}-md, /intel/items/{id}-md-xss');
  process.exit(2);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

//Capabilities по ролям — как в §4.1: owner-четвёрка лежит в /auth/me,
// reviewer-пара в /auth/me-reviewer; customer — только intel.run (запуск
// доступен владельцу и заказчику, ревью/экспорт — staff); viewer — ничего.
const CAPS = {
  owner: ['intel.run', 'intel.key_edit', 'intel.review', 'intel.export'],
  customer: ['intel.run'],
  reviewer: ['intel.review', 'intel.export'],
  viewer: [],
};

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(screen, opts) {
  opts = opts || {};
  const calls = {get: [], post: [], patch: [], fetch: [], toasts: [], modals: [], go: []};
  // Фейковый узел #intelMd — на каждый билд свой (как свой DOM у экрана).
  const mdEl = {innerHTML: '', textContent: ''};
  // Мутабельные ответы: проверки меняют их между шагами (N5/N6/N8).
  const st = {
    batch: clone(opts.batch || DETAIL),
    batch404: !!opts.batch404,
    failStart: opts.failStart || null,
    failResume: opts.failResume || null,
    failPatch: opts.failPatch || null,
    validate: clone(opts.validate || VALIDATE_ACK),
    list: clone(opts.list || LIST),
    items: clone(opts.items || ITEMS),
    card: clone(opts.card || CARD),
  };
  const api = {
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      if (p === '/intel/key') {
        if (opts.failKey) throw new Error(opts.failKey);
        return clone(opts.key || KEY);
      }
      if (p === '/intel/batches') {
        if (opts.failList) throw new Error(opts.failList);
        return clone(st.list);
      }
      if (/^\/intel\/batches\/\d+$/.test(p)) {
        if (st.batch404) { const e = new Error('пачка 3 не найдена'); e.status = 404; throw e; }
        return clone(st.batch);
      }
      if (/^\/intel\/batches\/\d+\/items$/.test(p)) return clone(st.items);
      if (/^\/intel\/items\/\d+$/.test(p)) {
        if (opts.failCard) throw new Error(opts.failCard);
        // сервер отвечает той строкой, что запросили: id ответа = id из пути
        const d = clone(st.card);
        d.id = Number(p.match(/^\/intel\/items\/(\d+)$/)[1]);
        return d;
      }
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => {
      calls.post.push({p: p, body: body || {}});
      if (p === '/intel/batches/validate') {
        if (opts.failValidate) throw new Error(opts.failValidate);
        return clone(st.validate);
      }
      if (p === '/intel/batches') {
        if (st.failStart) throw new Error(st.failStart);
        return clone(START_ACK);
      }
      if (/^\/intel\/batches\/\d+\/cancel$/.test(p)) return clone(CANCEL_ACK);
      if (/^\/intel\/batches\/\d+\/resume$/.test(p)) {
        if (st.failResume) throw new Error(st.failResume);
        return clone(RESUME_ACK);
      }
      throw new Error('нет образца ответа для ' + p);
    },
    patch: async (p, body) => {
      calls.patch.push({p: p, body: body || {}});
      if (/^\/intel\/items\/\d+$/.test(p)) {
        if (st.failPatch) throw new Error(st.failPatch);
        return clone(PATCH_ACK);
      }
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
    document: {createElement: () => ({click() {}, remove() {}}),
               // #intelMd — единственный id, который экран ищет в DOM
               // (запись Markdown, N-md1/N-md2). Фейковый узел на билд.
               getElementById: (id) => (id === 'intelMd' ? mdEl : null),
               body: {appendChild() {}}},
    // PUT экрана «Ключ Intel» идёт глобальным fetch (radar-api экспортирует
    // только get/post/patch/del) — примечание D1 к N2.
    fetch: async (url, init) => {
      calls.fetch.push({url: String(url),
                        method: (init && init.method) || 'GET',
                        body: (init && init.body) || null});
      return {ok: true, text: async () => JSON.stringify(opts.putAck || PUT_KEY)};
    },
    __imp: async (p) => {
      if (p.indexOf('radar-table') >= 0) return {Table: ctx.__Table};
      if (p.indexOf('md.js') >= 0) return {renderMarkdown: ctx.__renderMarkdown};
      if (p.indexOf('marked.esm.js') >= 0) return MARKED_NS;
      if (p.indexOf('purify.es.js') >= 0) return {default: PURIFY};
      return Object.assign({}, api, {
        API: '/api/v1',
        ApiError: class ApiError extends Error {
          constructor(status, path, body) {
            super(path + ' → ' + status);
            this.status = status; this.path = path; this.body = body;
          }
        },
      });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(tableSrc + '\n;this.__Table = Table;', ctx);
  vm.runInContext(mdSrc + '\n;this.__renderMarkdown = renderMarkdown;', ctx);

  // Роль и capabilities приходят в api — по ним экраны прячут формы и кнопки.
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast:(t, c)=>__calls.toasts.push({t: t, c: c}),
              modal:(m)=>__calls.modals.push(m),
              go:(r)=>__calls.go.push(r),
              drill(){}, trace(){},
              role: __role, capabilities: __caps.slice()}, mobile: __mobile}, {}); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        // componentDidUpdate — как в рантайме (support.js зовёт его после
        // каждого рендера): на нём висит запись Markdown в #intelMd.
        if (typeof this.componentDidUpdate === 'function') this.componentDidUpdate();
        if (cb) cb();
      }
    }`;
  ctx.__calls = calls;
  ctx.__role = opts.role || 'owner';
  ctx.__caps = CAPS[opts.role || 'owner'];
  ctx.__mobile = !!opts.mobile;
  vm.runInContext(base + '\n' + logicOf[screen].replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls, st: st, md: mdEl};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; } };

// Файл для input'а «Новая пачки»: у метода pickFile от стенда важны только
// name/size/text() — ровно то, что экран читает (file.text(), lesson D1).
function fakeFile(name, text) {
  return {name: name, size: text.length, text: async () => text};
}
const CSV = 'company,url\nACME,https://acme.example\nGlobex,https://globex.example';
const TEMPLATE = 'Исследуй {{company}} ({{url}})';
const BATCH_BODY = {
  name: 'Тестовая пачка',
  rows: [{company: 'ACME', url: 'https://acme.example'},
         {company: 'Globex', url: 'https://globex.example'}],
  prompt_template: TEMPLATE,
  schema_json: null, source_kind: 'csv', source_name: 'crm.csv',
};

// Подготовка «Новой пачки» до валидного состояния (N3/N4).
async function prepareBatch(c) {
  await c.pickFile({target: {files: [fakeFile('crm.csv', CSV)], value: ''}});
  await sleep();
  vals(c).setTemplate({target: {value: TEMPLATE}});
  vals(c).setName({target: {value: 'Тестовая пачка'}});
  await vals(c).doCheck();
  await sleep();
}

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {

  // N1. Ключ: монтаж → GET /intel/key ×1; значения дословно из фикстуры;
  // у роли без intel.key_edit формы нет, «Проверить связь» есть и зовёт ?probe=1.
  {
    const {c, calls} = build('key');
    const v0 = vals(c);
    check('N1 renderVals() до загрузки не падает', !v0.__err);
    await c.componentDidMount(); await sleep();
    const v = vals(c);
    const keyGets = calls.get.filter((g) => g.p === '/intel/key' && !g.q.probe);
    check('N1 GET /intel/key при монтаже ровно 1', keyGets.length === 1,
          JSON.stringify(calls.get));
    const row = (name) => v.viewRows.find((r) => r.k === name);
    check('N1 маска «' + KEY.masked + '» — дословно из фикстуры',
          !!row('Маска ключа') && row('Маска ключа').v === KEY.masked,
          JSON.stringify(v.viewRows && v.viewRows[0]));
    check('N1 concurrency=' + KEY.concurrency + ' и quota=' + KEY.quota_per_hour + ' — дословно',
          !!row('Строк параллельно') && row('Строк параллельно').v === KEY.concurrency &&
          !!row('Запросов в час') && row('Запросов в час').v === KEY.quota_per_hour);
    check('N1 остаток квоты из ratelimit: ' + KEY.ratelimit.remaining + ' из ' + KEY.ratelimit.limit,
          !!row('Остаток квоты') &&
          row('Остаток квоты').v === KEY.ratelimit.remaining + ' из ' + KEY.ratelimit.limit);

    const noEdit = build('key', {role: 'viewer'});
    await noEdit.c.componentDidMount(); await sleep();
    const vn = vals(noEdit.c);
    check('N1 у роли без intel.key_edit формы нет, «Проверить связь» есть',
          vn.canEdit === false && typeof vn.doProbe === 'function',
          JSON.stringify([vn.canEdit, typeof vn.doProbe]));

    const probe = build('key');
    await probe.c.componentDidMount(); await sleep();
    await vals(probe.c).doProbe(); await sleep();
    const probes = probe.calls.get.filter((g) => g.p === '/intel/key' && g.q.probe === 1);
    check('N1 «Проверить связь» → GET /intel/key?probe=1 ровно 1',
          probes.length === 1 && probes[0].q.probe === 1,
          JSON.stringify(probe.calls.get));
    check('N1 после удачного probe — тост «Связь есть»',
          probe.calls.toasts.some((t) => t.t === 'Связь есть' && t.c === '#2E7D57'),
          JSON.stringify(probe.calls.toasts));

    // Дефект 2 (browser-check): сервер отвечает 409 «ключ Intel ещё не сохранён —
    // сначала укажите адрес» на probe без строки адреса. Пока configured:false и
    // base_url пуст, «Проверить связь» обязана быть задизейблена с подсказкой
    // «сначала сохраните адрес»; форма и статус «не настроен» остаются доступны.
    const fresh = build('key', {key: KEY_EMPTY});
    await fresh.c.componentDidMount(); await sleep();
    const vfresh = vals(fresh.c);
    check('N1 ключ не сохранён (configured:false, без base_url): probe disabled, подсказка есть',
          vfresh.probeOff === true && vfresh.probeBlocked === true,
          JSON.stringify([vfresh.probeOff, vfresh.probeBlocked]));
    check('N1 ключ не сохранён: статус «не настроен», форма у owner на месте и пуста по адресу',
          vfresh.statusText === 'не настроен' && vfresh.canEdit === true &&
          vfresh.formBaseUrl === '',
          JSON.stringify([vfresh.statusText, vfresh.canEdit, vfresh.formBaseUrl]));
  }

  // N2. Сохранение: owner правит 4 поля → PUT /api/v1/intel/key ровно 1,
  // точное тело; тост успеха; у customer формы нет и PUT не уходит.
  {
    const {c, calls} = build('key', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    let v = vals(c);
    check('N2 у owner форма видна с текущими значениями',
          v.canEdit === true && v.formBaseUrl === KEY.base_url &&
          v.formEnv === KEY.api_key_env &&
          v.formConc === String(KEY.concurrency) &&
          v.formQuota === String(KEY.quota_per_hour));
    v.setFormBase({target: {value: 'http://intel:9000'}});
    vals(c).setFormEnv({target: {value: 'MY_INTEL_KEY'}});
    vals(c).setFormConc({target: {value: '3'}});
    vals(c).setFormQuota({target: {value: '800'}});
    await vals(c).doSave(); await sleep();
    const puts = calls.fetch.filter((f) => f.method === 'PUT');
    check('N2 PUT /api/v1/intel/key ровно 1 (fetch + API из модуля)',
          puts.length === 1 && puts[0].url === '/api/v1/intel/key',
          JSON.stringify(calls.fetch));
    check('N2 тело PUT — точное {base_url, api_key_env, concurrency, quota_per_hour}',
          puts.length === 1 &&
          JSON.stringify(JSON.parse(puts[0].body)) === JSON.stringify(
            {base_url: 'http://intel:9000', api_key_env: 'MY_INTEL_KEY',
             concurrency: 3, quota_per_hour: 800}),
          puts[0] && puts[0].body);
    check('N2 тост «Ключ сохранён»',
          calls.toasts.some((t) => t.t === 'Ключ сохранён' && t.c === '#2E7D57'),
          JSON.stringify(calls.toasts));

    const cust = build('key', {role: 'customer'});
    await cust.c.componentDidMount(); await sleep();
    const vc = vals(cust.c);
    check('N2 у customer формы нет', vc.canEdit === false);
    if (typeof vc.doSave === 'function') await vc.doSave();
    await sleep();
    check('N2 customer: PUT не уходит и тостов нет',
          cust.calls.fetch.length === 0 && cust.calls.toasts.length === 0);
  }

  // N3. Новая пачка: CSV через file.text() → сводка «строк: 2 · колонок: 2»;
  // «Запустить» disabled до проверки; «Проверить» — POST validate 1 раз с
  // телом {name, rows, prompt_template, schema_json, source_kind, source_name};
  // мутация validate ok:false → снова disabled, ошибка строки отрисована.
  {
    const {c, calls} = build('batch', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    check('N3 «Запустить» disabled до проверки', vals(c).runDisabled === true);
    await prepareBatch(c);
    const v = vals(c);
    check('N3 сводка файла «строк: 2 · колонок: 2»',
          v.sourceLoaded === true && v.sourceLabel.indexOf('строк: 2') >= 0 &&
          v.sourceLabel.indexOf('колонок: 2') >= 0, v.sourceLabel);
    const validates = calls.post.filter((p) => p.p === '/intel/batches/validate');
    check('N3 POST /intel/batches/validate ровно 1, тело по §2.б п.5',
          validates.length === 1 &&
          JSON.stringify(validates[0].body) === JSON.stringify(BATCH_BODY),
          JSON.stringify(validates[0] && validates[0].body));
    check('N3 после ok:true «Запустить» активен', vals(c).runDisabled === false);

    const bad = build('batch', {role: 'owner',
      validate: {ok: false,
                 errors: [{row: 2, field: 'query', message: 'в строке нет колонки url'}],
                 warnings: [], total: 2, estimated_quota_hours: 1}});
    await bad.c.componentDidMount(); await sleep();
    await prepareBatch(bad.c);
    const vb = vals(bad.c);
    check('N3 мутация validate ok:false → «Запустить» снова disabled',
          vb.runDisabled === true);
    check('N3 мутация: ошибка строки отрисована «Строка 2: в строке нет колонки url»',
          vb.hasErrors === true && vb.reportErrors[0].t === 'Строка 2: в строке нет колонки url',
          JSON.stringify(vb.reportErrors));
  }

  // N4. Запуск: POST /intel/batches 1 раз, точное тело; тост с batch_id;
  // go('intel_review'); мутация 409 «уже идёт пачка…» → красный тост, экран жив.
  {
    const {c, calls} = build('batch', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    await prepareBatch(c);
    await vals(c).doRun(); await sleep();
    const starts = calls.post.filter((p) => p.p === '/intel/batches');
    check('N4 POST /intel/batches ровно 1, то же тело, что у validate',
          starts.length === 1 &&
          JSON.stringify(starts[0].body) === JSON.stringify(BATCH_BODY),
          JSON.stringify(starts[0] && starts[0].body));
    check('N4 тост «Пачка №' + START_ACK.batch_id + ' запущена — прогон #' + START_ACK.run_id + '»',
          calls.toasts.some((t) => t.t === 'Пачка №' + START_ACK.batch_id +
            ' запущена — прогон #' + START_ACK.run_id),
          JSON.stringify(calls.toasts));
    check('N4 экран уходит на #intel_review (go в журнале)',
          calls.go.indexOf('intel_review') !== -1, JSON.stringify(calls.go));

    const conflict = build('batch', {role: 'owner',
      failStart: 'уже идёт пачка (прогон #7) — дождитесь или отмените'});
    await conflict.c.componentDidMount(); await sleep();
    await prepareBatch(conflict.c);
    // doRun на отказе обязан показать тост и остаться живым; если сам обработчик
    // падает — ловим и показываем в extra (сейчас так и есть: describe в doRun
    // объявлен внутри try, а читается в catch — RadarIntelBatch:288/:302; правка
    // описана в _REPORT-intel-gui-2.md, файл D1 этому стенду править нельзя).
    let runError = null;
    try { await vals(conflict.c).doRun(); } catch (e) { runError = e; }
    await sleep();
    check('N4 мутация 409: красный тост с текстом сервера',
          conflict.calls.toasts.some((t) => t.c === '#DA501C' &&
            /уже идёт пачка \(прогон #7\)/.test(t.t)),
          runError ? ('обработчик doRun упал: ' + runError.message)
                   : JSON.stringify(conflict.calls.toasts));
    check('N4 мутация 409: экран жив (renderVals не падает)', !vals(conflict.c).__err);
  }

  // N5. Ревью-список: монтаж → GET /intel/batches; клик пачки → деталь + items;
  // фильтр review_status=new по умолчанию; смена фильтра → новый GET;
  // пустые состояния; 404 → назад к списку с тостом.
  {
    const {c, calls} = build('review', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    check('N5 GET /intel/batches при монтаже (limit 50)',
          calls.get.some((g) => g.p === '/intel/batches' && g.q.limit === 50),
          JSON.stringify(calls.get));
    let v = vals(c);
    check('N5 статусы пачек словами: running → «выполняется», done → «готова»',
          v.batchRows.length === LIST.rows.length &&
          v.batchRows[0].badge === 'выполняется' &&
          v.batchRows[1].badge === 'готова',
          JSON.stringify(v.batchRows.map((b) => b.badge)));
    check('N5 failed>0 показан красным в строке списка',
          v.batchRows[0].hasFailed === true && v.batchRows[0].failed === 1);

    v.batchRows[0].open(); await sleep();
    const details = calls.get.filter((g) => /^\/intel\/batches\/\d+$/.test(g.p));
    const itemGets = calls.get.filter((g) => /^\/intel\/batches\/\d+\/items$/.test(g.p));
    check('N5 клик по пачке → GET /intel/batches/{id} + /items',
          details.length === 1 && itemGets.length === 1,
          JSON.stringify(calls.get));
    check('N5 первый GET items несёт review_status=new («нужно ревью» по умолчанию)',
          itemGets[0].q.review_status === 'new', JSON.stringify(itemGets[0].q));
    v = vals(c);
    check('N5 шапка пачки: прогресс и «ждёт модель» из фикстуры',
          v.bProgressLine.indexOf('12 готово') >= 0 &&
          v.bProgressLine.indexOf('1 упало') >= 0 &&
          v.bWaitingLine === 'ждёт модель: 1 · выполняется: 2',
          JSON.stringify([v.bProgressLine, v.bWaitingLine]));
    check('N5 лог пачки — последние строки моно-блоком (2 строки из фикстуры)',
          v.hasLog === true && v.logRows.length === 2 &&
          v.logRows[0] === DETAIL.log[0]);

    v = vals(c);
    v.setReview({target: {value: 'accepted'}});
    await sleep();
    const itemGets2 = calls.get.filter((g) => /^\/intel\/batches\/\d+\/items$/.test(g.p));
    check('N5 смена фильтра → новый GET items с review_status=accepted',
          itemGets2.length === 2 && itemGets2[1].q.review_status === 'accepted');

    const {c: c3, calls: calls3} = build('review', {role: 'owner'});
    await c3.componentDidMount(); await sleep();
    vals(c3).batchRows[0].open(); await sleep();
    const v3 = vals(c3);
    check('N5 статусы строк — по словарю: «ждёт модель», «застяла», «отменена»',
          v3.rows.some((r) => r.statusLabel === 'ждёт модель') &&
          v3.rows.some((r) => r.statusLabel === 'застяла') &&
          v3.rows.some((r) => r.statusLabel === 'отменена'),
          JSON.stringify(v3.rows.map((r) => r.statusLabel)));
    check('N5 бейджи ревью: новая/принята/отклонена',
          v3.rows.some((r) => r.reviewLabel === 'новая') &&
          v3.rows.some((r) => r.reviewLabel === 'принята') &&
          v3.rows.some((r) => r.reviewLabel === 'отклонена'));

    // Мутация заглушки: сервер прислал cancelled → «остановлена» (не «canceled»!).
    // Меняются ОБА ответа сервера — список и деталь: экран должен обновить и
    // строку списка, и шапку из перечитанных ручек.
    const mut = build('review', {role: 'owner'});
    await mut.c.componentDidMount(); await sleep();
    vals(mut.c).batchRows[0].open(); await sleep();
    mut.st.batch.status = 'cancelled';
    mut.st.list.rows[0].status = 'cancelled';
    await vals(mut.c).reload(); await sleep();
    check('N5 мутация: пачка cancelled → «остановлена»',
          vals(mut.c).bStatusLabel === 'остановлена' &&
          vals(mut.c).batchRows[0].badge === 'остановлена',
          JSON.stringify([vals(mut.c).bStatusLabel, vals(mut.c).batchRows[0].badge]));

    const empty = build('review', {list: {limit: 50, offset: 0, total: 0, rows: []}});
    await empty.c.componentDidMount(); await sleep();
    const ve = vals(empty.c);
    check('N5 пачек нет — «Пачек ещё не было…» и ссылка на «Новая пачка»',
          ve.batchesEmpty === true && typeof ve.goNewBatch === 'function');
    ve.goNewBatch();
    check('N5 ссылка «Новая пачка» ведёт на intel_batch (go в журнале)',
          empty.calls.go.indexOf('intel_batch') !== -1, JSON.stringify(empty.calls.go));

    const noItems = build('review', {items: {limit: 50, offset: 0, total: 0, rows: []}});
    await noItems.c.componentDidMount(); await sleep();
    vals(noItems.c).batchRows[0].open(); await sleep();
    check('N5 в пачке нет строк под фильтром — «Под этот фильтр строк нет»',
          vals(noItems.c).itemsEmpty === true && vals(noItems.c).hasRows === false);

    const failed = build('review', {failList: 'база недоступна'});
    await failed.c.componentDidMount(); await sleep();
    check('N5 отказ списка — inline «Пачки не открылись: {describe}»',
          vals(failed.c).hasListError === true &&
          vals(failed.c).listErrorMsg === 'база недоступна',
          JSON.stringify(vals(failed.c).listErrorMsg));

    const gone = build('review', {role: 'owner'});
    await gone.c.componentDidMount(); await sleep();
    gone.st.batch404 = true;
    vals(gone.c).batchRows[0].open(); await sleep();
    check('N5 404 пачки: назад к списку, тост, детали нет',
          vals(gone.c).hasBatch === false && vals(gone.c).noSelection === true &&
          gone.calls.toasts.some((t) => t.c === '#DA501C' && /не найдена/.test(t.t)),
          JSON.stringify(gone.calls.toasts));
  }

  // N6. Опрос: выбор running-пачки при малом POLL_MS → через ~2 тика в журнале
  // вторые GET той же пары; мутация st.batch.status='done' → новых GET нет;
  // componentWillUnmount гасит таймер.
  {
    const {c, calls, st} = build('review', {role: 'owner'});
    c.POLL_MS = 20;
    await c.componentDidMount(); await sleep();
    vals(c).batchRows[0].open(); await sleep();
    const detCount = () => calls.get.filter((g) => /^\/intel\/batches\/\d+$/.test(g.p)).length;
    const itemCount = () => calls.get.filter((g) => /^\/intel\/batches\/\d+\/items$/.test(g.p)).length;
    const d0 = detCount(), i0 = itemCount();
    await new Promise((r) => setTimeout(r, 70));
    check('N6 пока пачка running — пара GET повторяется (~2 тика по POLL_MS)',
          detCount() >= d0 + 2 && itemCount() >= i0 + 2,
          'деталей ' + (detCount() - d0) + ', списков ' + (itemCount() - i0));

    st.batch.status = 'done';
    await new Promise((r) => setTimeout(r, 40));
    await sleep();
    const d1 = detCount(), i1 = itemCount();
    await new Promise((r) => setTimeout(r, 90));
    check('N6 терминальный статус (done): новых GET нет, таймер остановлен',
          detCount() === d1 && itemCount() === i1,
          'было ' + d1 + '/' + i1 + ', стало ' + detCount() + '/' + itemCount());

    st.batch.status = 'running';
    vals(c).reload(); await sleep();
    c.componentWillUnmount();
    const d2 = detCount();
    await new Promise((r) => setTimeout(r, 90));
    check('N6 componentWillUnmount гасит таймер (новых GET нет)',
          detCount() === d2, 'было ' + d2 + ', стало ' + detCount());
  }

  // N7. Отмена: одна модалка с confirm «Отменить»; run() → POST cancel 1 раз;
  // строка пачки и шапка обновляются из ответа {id, status}.
  {
    const {c, calls} = build('review', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    vals(c).batchRows[0].open(); await sleep();
    let v = vals(c);
    check('N7 у running-пачки с intel.run есть «Отменить»', v.canCancel === true);
    v.doCancel(); await sleep();
    check('N7 ровно одна модалка, confirm «Отменить», btnBg красный',
          calls.modals.length === 1 && calls.modals[0].confirm === 'Отменить' &&
          calls.modals[0].btnBg === '#DA501C' &&
          typeof calls.modals[0].run === 'function',
          JSON.stringify(calls.modals.map((m) => [m.title, m.confirm])));
    check('N7 до подтверждения POST cancel не уходит', calls.post.length === 0);
    await calls.modals[0].run(); await sleep();
    const cancels = calls.post.filter((p) => /\/cancel$/.test(p.p));
    check('N7 run() → POST /intel/batches/3/cancel ровно 1',
          cancels.length === 1 && cancels[0].p === '/intel/batches/3/cancel',
          JSON.stringify(calls.post));
    v = vals(c);
    check('N7 строка пачки обновлена из ответа {id:3, status:"cancelled"} → «остановлена»',
          v.batchRows[0].badge === 'остановлена' && v.bStatusLabel === 'остановлена' &&
          v.canCancel === false,
          JSON.stringify([v.batchRows[0].badge, v.bStatusLabel]));
  }

  // N-res. Возобновление (Radar 8475607): у пачки с run_status:"failed" (прогон
  // упал, пачка ещё running) есть «Возобновить» и красное «Прогон #N упал»;
  // клик → POST …/resume сразу, без модалки; тост «возобновлена», run_id и
  // run_status в состоянии из ответа; при run_status:"running" кнопки нет;
  // 409 «прогон #12 ещё идёт» → красный тост, кнопка на месте; reviewer
  // (без intel.run) кнопки нет. Мутация «убрать условие run_status из
  // canResume» красит N-res2 (снята в отчёте _REPORT-intel-resume-gui.md).
  {
    const failed = build('review', {role: 'owner', batch: DETAIL_FAILED});
    await failed.c.componentDidMount(); await sleep();
    vals(failed.c).batchRows[0].open(); await sleep();
    let v = vals(failed.c);
    check('N-res1 у run_status:"failed" есть «Возобновить» и красное «Прогон #' +
          DETAIL_FAILED.run_id + ' упал»',
          v.canResume === true && v.hasRunFail === true &&
          v.bRunFailLine === 'Прогон #' + DETAIL_FAILED.run_id + ' упал',
          JSON.stringify([v.canResume, v.hasRunFail, v.bRunFailLine]));
    await vals(failed.c).doResume(); await sleep();
    const resumes = failed.calls.post.filter((p) => /\/resume$/.test(p.p));
    check('N-res1 клик → POST /intel/batches/3/resume ровно 1, тело {}',
          resumes.length === 1 && resumes[0].p === '/intel/batches/3/resume' &&
          JSON.stringify(resumes[0].body) === '{}',
          JSON.stringify(failed.calls.post));
    check('N-res1 тост «Пачка №' + RESUME_ACK.batch_id + ' возобновлена — прогон #' +
          RESUME_ACK.run_id + '»',
          failed.calls.toasts.some((t) => t.t === 'Пачка №' + RESUME_ACK.batch_id +
            ' возобновлена — прогон #' + RESUME_ACK.run_id),
          JSON.stringify(failed.calls.toasts));
    check('N-res1 run_id в состоянии = ' + RESUME_ACK.run_id + ', run_status = "queued"',
          failed.c.state.batch.run_id === RESUME_ACK.run_id &&
          failed.c.state.batch.run_status === 'queued',
          JSON.stringify([failed.c.state.batch.run_id, failed.c.state.batch.run_status]));

    // N-res2: прогон жив (run_status:"running", дефолтная деталь) — возобновлять
    // нечего, кнопки нет.
    const running = build('review', {role: 'owner'});
    await running.c.componentDidMount(); await sleep();
    vals(running.c).batchRows[0].open(); await sleep();
    v = vals(running.c);
    check('N-res2 при run_status:"running" кнопки «Возобновить» нет',
          v.canResume === false, JSON.stringify(v.canResume));

    // N-res3: сервер отвечает 409 «прогон #12 ещё идёт» — красный тост,
    // кнопка на месте, экран жив.
    const busy = build('review', {role: 'owner', batch: DETAIL_FAILED,
                                  failResume: 'прогон #12 ещё идёт'});
    await busy.c.componentDidMount(); await sleep();
    vals(busy.c).batchRows[0].open(); await sleep();
    await vals(busy.c).doResume(); await sleep();
    check('N-res3 мутация 409: красный тост с текстом сервера',
          busy.calls.toasts.some((t) => t.c === '#DA501C' &&
            /прогон #12 ещё идёт/.test(t.t)),
          JSON.stringify(busy.calls.toasts));
    check('N-res3 кнопка «Возобновить» на месте, экран жив',
          vals(busy.c).canResume === true && !vals(busy.c).__err);

    // N-res4: у reviewer права intel.run нет — кнопки нет вовсе.
    const rev = build('review', {role: 'reviewer', batch: DETAIL_FAILED});
    await rev.c.componentDidMount(); await sleep();
    vals(rev.c).batchRows[0].open(); await sleep();
    check('N-res4 reviewer (без intel.run) кнопки «Возобновить» нет',
          vals(rev.c).canResume === false);
  }

  // N8. Карточка и PATCH: клик строки → GET /intel/items/{id}; output с
  // правками, источники, критик; «Принять» → PATCH {review_status}; заметка →
  // {notes}; правка поля → {edited} с путём через точку; мутация 422 →
  // красный тост, значение не изменилось.
  {
    const {c, calls} = build('review', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    vals(c).batchRows[0].open(); await sleep();
    let v = vals(c);
    const row = v.rows.find((r) => r.id === 301);
    check('N8 у строки есть открытие карточки', !!row && typeof row.open === 'function');
    row.open(); await sleep();
    check('N8 клик строки → GET /intel/items/301 ровно 1',
          calls.get.filter((g) => g.p === '/intel/items/301').length === 1);
    v = vals(c);
    check('N8 карточка: output с правками — segment=B2C (правка применена), contacts.site — путь через точку',
          v.hasStructured === true &&
          v.cardOutputRows.some((o) => o.k === 'segment' && o.v === 'B2C') &&
          v.cardOutputRows.some((o) => o.k === 'contacts.site' && o.v === 'https://acme.example'),
          JSON.stringify(v.cardOutputRows));
    check('N8 карточка: 2 источника-ссылки из фикстуры',
          v.cardSources.length === 2 &&
          v.cardSources[0].url === CARD.result.sources[0].url &&
          v.cardSources[0].what === CARD.result.sources[0].what_it_provided,
          JSON.stringify(v.cardSources));
    check('N8 карточка: критик 8.5 и токены 3200 из result.stats',
          v.cardStats.indexOf('8.5') >= 0 && v.cardStats.indexOf('3200') >= 0,
          v.cardStats);
    check('N8 карточка: вход ключ-значение (company=ACME)',
          v.cardInputRows.some((r) => r.k === 'company' && r.v === 'ACME'),
          JSON.stringify(v.cardInputRows));

    // Дефект 4 (browser-check): у failed-строки вместо причины рисовалось
    // «Ответа ещё нет», а card.error из GET /intel/items/{id} не показывался.
    // Карточка обязана показать причину (текст error) и не показывать заглушку.
    const dead = build('review', {role: 'owner', card: CARD_FAILED});
    await dead.c.componentDidMount(); await sleep();
    vals(dead.c).batchRows[0].open(); await sleep();
    vals(dead.c).rows.find((r) => r.id === 301).open(); await sleep();
    const vdead = vals(dead.c);
    check('N8 failed-строка: причина «' + CARD_FAILED.error + '» отрисована в карточке',
          vdead.hasCardFail === true && vdead.cardFailText === CARD_FAILED.error,
          JSON.stringify([vdead.hasCardFail, vdead.cardFailText]));
    check('N8 failed-строка: заглушки «Ответа ещё нет» нет',
          vdead.noAnswer === false);
    check('N8 failed-строка: карточка жива (вход ключ-значение из фикстуры)',
          vdead.cardInputRows.some((r) => r.k === 'company' && r.v === 'Globex'),
          JSON.stringify(vdead.cardInputRows));

    // Та же причина — у stalled («застяла»): ответ не придёт и там.
    const stuck = build('review', {role: 'owner',
      card: Object.assign(clone(CARD_FAILED), {status: 'stalled'})});
    await stuck.c.componentDidMount(); await sleep();
    vals(stuck.c).batchRows[0].open(); await sleep();
    vals(stuck.c).rows.find((r) => r.id === 301).open(); await sleep();
    check('N8 stalled-строка: причина отрисована, заглушки нет',
          vals(stuck.c).hasCardFail === true &&
          vals(stuck.c).cardFailText === CARD_FAILED.error &&
          vals(stuck.c).noAnswer === false);

    // Оборотная сторона: у ждущей строки (waiting_llm) заглушка на месте,
    // причины нет — ответ ещё может приехать.
    const waiting = build('review', {role: 'owner',
      card: Object.assign(clone(CARD_FAILED), {status: 'waiting_llm', error: null})});
    await waiting.c.componentDidMount(); await sleep();
    vals(waiting.c).batchRows[0].open(); await sleep();
    vals(waiting.c).rows.find((r) => r.id === 301).open(); await sleep();
    check('N8 waiting_llm-строка: «Ответа ещё нет», блока причины нет',
          vals(waiting.c).noAnswer === true &&
          vals(waiting.c).hasCardFail === false);

    v.doAccept(); await sleep();
    const patches = calls.patch.filter((p) => p.p === '/intel/items/301');
    check('N8 «Принять» → PATCH ровно 1 с телом {review_status:"accepted"}',
          patches.length === 1 &&
          JSON.stringify(patches[0].body) === JSON.stringify({review_status: 'accepted'}),
          JSON.stringify(patches[0] && patches[0].body));
    v = vals(c);
    check('N8 карточка обновилась из ответа: бейдж «принята», бейдж строки тоже',
          v.cardReviewLabel === 'принята' &&
          v.rows.find((r) => r.id === 301).reviewLabel === 'принята');

    v = vals(c);
    v.setNote({target: {value: 'проверено'}});
    vals(c).saveNote(); await sleep();
    const notePatches = calls.patch.filter(
      (p) => JSON.stringify(p.body) === JSON.stringify({notes: 'проверено'}));
    check('N8 заметка → PATCH {notes:"проверено"} ровно 1', notePatches.length === 1,
          JSON.stringify(calls.patch));

    v = vals(c);
    const siteRow = v.cardOutputRows.find((o) => o.k === 'contacts.site');
    siteRow.edit(); await sleep();
    v = vals(c);
    const editing = v.cardOutputRows.find((o) => o.k === 'contacts.site');
    check('N8 клик по значению открыл инлайн-инпут с прежним значением',
          editing.editing === true && editing.editVal === 'https://acme.example');
    editing.setEdit({target: {value: 'https://acme-new.example'}});
    vals(c).cardOutputRows.find((o) => o.k === 'contacts.site').saveEdit(); await sleep();
    const editPatches = calls.patch.filter((p) => p.body && p.body.edited &&
                                                    p.body.edited['contacts.site']);
    check('N8 правка поля → PATCH {edited:{…старое, "путь.ключ": новое}}',
          editPatches.length === 1 &&
          editPatches[0].body.edited['contacts.site'] === 'https://acme-new.example' &&
          editPatches[0].body.edited.segment === 'B2C',
          JSON.stringify(editPatches[0] && editPatches[0].body));

    // Мутация: сервер отвечает 422 «правка не проходит схему: …».
    const refused = build('review', {role: 'owner',
      failPatch: 'правка не проходит схему: additionalProperties unexpected'});
    await refused.c.componentDidMount(); await sleep();
    vals(refused.c).batchRows[0].open(); await sleep();
    vals(refused.c).rows.find((r) => r.id === 301).open(); await sleep();
    let vr = vals(refused.c);
    vr.cardOutputRows.find((o) => o.k === 'size').edit();
    vals(refused.c).cardOutputRows.find((o) => o.k === 'size')
        .setEdit({target: {value: 'enterprise'}});
    vals(refused.c).cardOutputRows.find((o) => o.k === 'size').saveEdit(); await sleep();
    check('N8 мутация 422: красный тост с текстом сервера',
          refused.calls.toasts.some((t) => t.c === '#DA501C' &&
            /правка не проходит схему/.test(t.t)),
          JSON.stringify(refused.calls.toasts));
    vr = vals(refused.c);
    check('N8 мутация 422: значение в карточке не изменилось (size=mid)',
          vr.cardOutputRows.find((o) => o.k === 'size').v === 'mid',
          JSON.stringify(vr.cardOutputRows.find((o) => o.k === 'size')));
  }

  // N9. Экспорт: прямые ссылки при intel.export; параметр review_status
  // повторяет активный фильтр («все» — параметра нет); у customer ссылок нет.
  {
    const {c, calls} = build('review', {role: 'owner'});
    await c.componentDidMount(); await sleep();
    vals(c).batchRows[0].open(); await sleep();
    let v = vals(c);
    check('N9 у owner (intel.export) ссылки экспорта есть', v.hasExport === true);
    check('N9 href CSV = /api/v1/intel/batches/3/export?format=csv&review_status=new',
          v.exportCsvHref === '/api/v1/intel/batches/3/export?format=csv&review_status=new',
          v.exportCsvHref);
    check('N9 href JSON = /api/v1/intel/batches/3/export?format=json&review_status=new',
          v.exportJsonHref === '/api/v1/intel/batches/3/export?format=json&review_status=new',
          v.exportJsonHref);
    check('N9 экспорт — <a href download>, не api.get (в журнале GET export нет)',
          !calls.get.some((g) => g.p.indexOf('/export') >= 0));
    v = vals(c);
    v.setReview({target: {value: ''}});
    await sleep();
    v = vals(c);
    check('N9 фильтр «все» — параметр review_status не передаётся',
          v.exportCsvHref === '/api/v1/intel/batches/3/export?format=csv',
          v.exportCsvHref);

    const cust = build('review', {role: 'customer'});
    await cust.c.componentDidMount(); await sleep();
    vals(cust.c).batchRows[0].open(); await sleep();
    check('N9 у customer (без intel.export) ссылок нет',
          vals(cust.c).hasExport === false);
  }

  // N10. Права по capabilities: без intel.run нет «Запустить»/«Отменить»;
  // без intel.review карточка только для чтения; приём «reviewer видит
  // список, но нет кнопок».
  {
    const cust = build('review', {role: 'customer'});
    await cust.c.componentDidMount(); await sleep();
    vals(cust.c).batchRows[0].open(); await sleep();
    let v = vals(cust.c);
    check('N10 customer: «Отменить» есть (intel.run), карточка read-only (нет intel.review)',
          v.canCancel === true && v.canReview === false &&
          v.cardOutputRows.every((o) => o.cursor === 'default'),
          JSON.stringify([v.canCancel, v.canReview]));

    const rev = build('review', {role: 'reviewer'});
    await rev.c.componentDidMount(); await sleep();
    vals(rev.c).batchRows[0].open(); await sleep();
    v = vals(rev.c);
    check('N10 reviewer: список и строки видны',
          !v.__err && v.rows.length === ITEMS.rows.length && v.batchRows.length === 2);
    const row = v.rows.find((r) => r.id === 301);
    row.open(); await sleep();
    v = vals(rev.c);
    // У Intel-ревьюера есть intel.review+intel.export (фикстура /auth/me-reviewer,
    // §4.1): действия карточки и экспорт видны, «Отменить» (intel.run) — нет.
    check('N10 reviewer: «Отменить» нет (нет intel.run), экспорт и действия карточки есть',
          v.canCancel === false && v.hasExport === true && v.canReview === true &&
          v.cardOutputRows.every((o) => o.cursor === 'pointer'),
          JSON.stringify([v.canCancel, v.hasExport, v.canReview]));
    check('N10 reviewer ничего не отправляет', rev.calls.post.length === 0 &&
          rev.calls.patch.length === 0);

    const noRun = build('batch', {role: 'reviewer'});
    await noRun.c.componentDidMount(); await sleep();
    check('N10 без intel.run «Новая пачка» — заглушка вместо формы',
          vals(noRun.c).noRun === true && vals(noRun.c).canRun === false);

    const none = build('review', {role: 'viewer'});
    await none.c.componentDidMount(); await sleep();
    vals(none.c).batchRows[0].open(); await sleep();
    v = vals(none.c);
    check('N10 без caps вовсе: ни «Отменить», ни экспорта, ни действий карточки',
          v.canCancel === false && v.hasExport === false && v.canReview === false);
  }

  // N-md1. Markdown в карточке: фикстура со строковым output («# Заголовок…»)
  // → после открытия строки в #intelMd есть <h1>, <strong>, <code>; переход на
  // структурную строку узел очищает. Мутация «убрать запись innerHTML в
  // componentDidUpdate» красит обе первые проверки (снята в отчёте).
  {
    const md = build('review', {role: 'owner', card: CARD_MD});
    await md.c.componentDidMount(); await sleep();
    vals(md.c).batchRows[0].open(); await sleep();
    vals(md.c).rows.find((r) => r.id === 301).open(); await sleep();
    const vm1 = vals(md.c);
    check('N-md1 строковый output → hasMarkdown, структурных строк нет',
          vm1.hasMarkdown === true && vm1.hasStructured === false &&
          vm1.noAnswer === false && vm1.cardOutputRows.length === 0,
          JSON.stringify([vm1.hasMarkdown, vm1.hasStructured]));
    check('N-md1 в #intelMd есть <h1> с текстом «Заголовок»',
          /<h1[^>]*>\s*Заголовок\s*<\/h1>/.test(md.md.innerHTML), md.md.innerHTML);
    check('N-md1 в #intelMd есть <strong>жирно</strong> и <code>код</code>',
          /<strong>\s*жирно\s*<\/strong>/.test(md.md.innerHTML) &&
          /<code>\s*код\s*<\/code>/.test(md.md.innerHTML), md.md.innerHTML);
    md.st.card = clone(CARD); // теперь сервер вернёт структурную карточку
    vals(md.c).rows.find((r) => r.id === 302).open(); await sleep();
    check('N-md1 переход на структурную строку очищает #intelMd',
          md.md.innerHTML === '', JSON.stringify(md.md.innerHTML));
  }

  // N-md2. Санитизация: output с <img onerror> и javascript:-ссылкой → в
  // #intelMd нет onerror и javascript:, текст уцелел; ссылка получила
  // target/_blank + rel из хука afterSanitizeAttributes.
  {
    const xss = build('review', {role: 'owner', card: CARD_MD_XSS});
    await xss.c.componentDidMount(); await sleep();
    vals(xss.c).batchRows[0].open(); await sleep();
    vals(xss.c).rows.find((r) => r.id === 301).open(); await sleep();
    const html = xss.md.innerHTML;
    check('N-md2 в #intelMd нет onerror', html.indexOf('onerror') === -1, html);
    check('N-md2 в #intelMd нет javascript:-URL', !/javascript\s*:/i.test(html), html);
    check('N-md2 текст «текст» присутствует', html.indexOf('текст') !== -1, html);
    check('N-md2 ссылка открылась в новой вкладке: target=_blank, rel=noopener noreferrer',
          /<a [^>]*target="_blank"/.test(html) && /<a [^>]*rel="noopener noreferrer"/.test(html),
          html);
  }

  // N-nav. Переход по строкам из шапки карточки: «строка N из M», края гаснут,
  // «след.»/«пред.» зовут тот же GET /intel/items/{id}; выбранная строка
  // подсвечена; sticky таблицы на десктопе и отключение на mobile.
  {
    const nav = build('review', {role: 'owner',
      items: {limit: 50, offset: 0, total: 3, rows: clone(ITEMS.rows.slice(0, 3))}});
    await nav.c.componentDidMount(); await sleep();
    vals(nav.c).batchRows[0].open(); await sleep();
    let v = vals(nav.c);
    check('N-nav в списке 3 строки, до открытия карточки переходов нет',
          v.rows.length === 3 && v.hasRowNav === false);
    check('N-nav sticky таблицы на десктопе (position/top/max-height из renderVals)',
          /position:sticky/.test(v.listStickyStyle) &&
          /top:12px/.test(v.listStickyStyle) &&
          /max-height:calc\(100vh - 96px\)/.test(v.listStickyStyle) &&
          /overflow:auto/.test(v.listStickyStyle),
          v.listStickyStyle);
    const mob = build('review', {role: 'owner', mobile: true});
    await mob.c.componentDidMount(); await sleep();
    vals(mob.c).batchRows[0].open(); await sleep();
    check('N-nav на mobile sticky отключён — карточка не перекрывает таблицу',
          vals(mob.c).listStickyStyle === '', vals(mob.c).listStickyStyle);

    v = vals(nav.c);
    v.rows[0].open(); await sleep();
    v = vals(nav.c);
    check('N-nav открытая строка 1 из 3: подпись и «пред.» disabled',
          v.rowPosLabel === 'строка 1 из 3' &&
          v.rowNavPrevFg === '#C9CCD6' && v.rowNavPrevCursor === 'default' &&
          v.rowNavNextFg === '#156479', JSON.stringify(v.rowPosLabel));
    check('N-nav выбранная строка подсвечена, соседние — нет',
          v.rows[0].bg === 'rgba(148,190,190,0.18)' &&
          v.rows[1].bg !== 'rgba(148,190,190,0.18)',
          JSON.stringify(v.rows.map((r) => r.bg)));
    const gets301 = () => nav.calls.get.filter((g) => g.p === '/intel/items/301').length;
    const gets302 = () => nav.calls.get.filter((g) => g.p === '/intel/items/302').length;
    const gets303 = () => nav.calls.get.filter((g) => g.p === '/intel/items/303').length;
    check('N-nav до навигации GET items/{id} по одному на строку 301',
          gets301() === 1 && gets302() === 0 && gets303() === 0);
    v.nextRow(); await sleep();
    check('N-nav «след.» → GET /intel/items/302 (тот же путь, что клик по строке)',
          gets302() === 1, JSON.stringify(nav.calls.get.map((g) => g.p)));
    v = vals(nav.c);
    check('N-nav на второй: подпись «строка 2 из 3», подсветка сместилась, обе кнопки активны',
          v.rowPosLabel === 'строка 2 из 3' &&
          v.rows[1].bg === 'rgba(148,190,190,0.18)' && v.rows[0].bg === '' &&
          v.rowNavPrevFg === '#156479' && v.rowNavNextFg === '#156479');
    v.prevRow(); await sleep();
    check('N-nav «пред.» со второй → GET /intel/items/301 (второй раз: открытие + возврат)',
          gets301() === 2 && gets302() === 1);
    v = vals(nav.c);
    v.nextRow(); await sleep(); v = vals(nav.c); // 1 → 2
    v.nextRow(); await sleep(); v = vals(nav.c); // 2 → 3 (последняя)
    check('N-nav на последней: подпись «строка 3 из 3», «след.» disabled',
          v.rowPosLabel === 'строка 3 из 3' &&
          v.rowNavNextFg === '#C9CCD6' && v.rowNavNextCursor === 'default');
    const before303 = gets303();
    v.nextRow(); await sleep();
    check('N-nav «след.» на последней не запрашивает ничего',
          gets303() === before303);
    const beforeAll = nav.calls.get.length;
    v.prevRow(); await sleep();
    check('N-nav «пред.» с последней работает: +1 GET items/302 (третий заход на неё)',
          nav.calls.get.length === beforeAll + 1 && gets302() === 3,
          JSON.stringify(nav.calls.get.map((g) => g.p)));
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
