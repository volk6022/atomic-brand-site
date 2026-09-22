// Поведенческая проверка экрана «Яндекс-карты» (RadarIntelYandex.dc.html) —
// по образцу check-intel.js: настоящий блок логики экрана исполняется под
// записывающим API, кнопки нажимаются по-настоящему. Значения ответа —
// дословно из `api-fixtures.json` («POST /intel/yandex», 3 строки, одна
// красная с captcha). Это контракт: правится экран, а не файл.
//
// Что проверяется (по задаче _TASK-yandex-maps-gui.md):
//   • разбор входа: CSV с «;», с кавычками (удвоение) и с BOM; JSON-массив;
//     голые строки без заголовка для extract (строка = {query});
//   • сборка CSV на выходе: экранирование запятой и кавычки (RFC 4180),
//     пустые поля остаются пустыми, BOM в начале;
//   • блокировка «Запустить» при 0 и >50 строках (и на время запроса);
//   • отрисовка таблицы по фикстуре: 3 строки, одна красная, сводка;
//   • 409 → подсказка про «Ключ Intel» (go в журнале), экран жив.
//
//     node check-intel-yandex.js .
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const YANDEX = fixtures['POST /intel/yandex'];

if (!YANDEX || !Array.isArray(YANDEX.results) || YANDEX.results.length !== 3) {
  console.error('нет образца «POST /intel/yandex» в api-fixtures.json (3 строки, одна с error.code captcha)');
  process.exit(2);
}

const results = [];
function check(name, cond, extra) { results.push([cond ? 'ok  ' : 'FAIL', extra ? name + ' — ' + extra : name]); }

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

const LOGIC = (() => {
  const src = fs.readFileSync(DIR + '/RadarIntelYandex.dc.html', 'utf8');
  return src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
})();

function build(opts) {
  opts = opts || {};
  const calls = {post: [], toasts: [], go: [], anchors: [], blobs: []};
  const st = {resolvePost: null};
  const api = {
    post: async (p, body) => {
      calls.post.push({p: p, body: body || {}});
      if (opts.fail409) {
        // Как ApiError из radar-api.js: status и body на объекте ошибки.
        const e = new Error(p + ' → 409');
        e.status = 409;
        e.body = {detail: 'ключ Intel не заведён'};
        throw e;
      }
      const resp = clone(opts.resp || YANDEX);
      if (opts.hold) return await new Promise((res) => { st.resolvePost = () => res(resp); });
      return resp;
    },
    get: async () => { throw new Error('экран не должен ничего читать — только POST /intel/yandex'); },
    describe: (e) => (e && e.message) ? String(e.message) : String(e),
  };
  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, RegExp,
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    window: {addEventListener() {}, removeEventListener() {}},
    document: {createElement: () => ({click() { calls.anchors.push(this); }, remove() {}}),
               body: {appendChild() {}}},
    Blob: class { constructor(parts, opts2) { this.parts = parts; this.type = opts2 && opts2.type; } },
    URL: {createObjectURL: (b) => { calls.blobs.push(b); return 'blob:fake'; },
          revokeObjectURL: () => {}},
    __imp: async (p) => Object.assign({}, api, {
      API: '/api/v1',
      ApiError: class ApiError extends Error {
        constructor(status, path, body) {
          super(path + ' → ' + status);
          this.status = status; this.path = path; this.body = body;
        }
      },
    }),
  };
  vm.createContext(ctx);
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast:(t, c)=>__calls.toasts.push({t: t, c: c}),
              go:(r)=>__calls.go.push(r), modal(){}, trace(){}, drill(){}},
         mobile: __mobile}, {}); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__calls = calls;
  ctx.__mobile = !!opts.mobile;
  vm.runInContext(base + '\n' + LOGIC.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  const c = new ctx.__C();
  if (typeof c.componentDidMount === 'function') { /* на этом экране данных при монтаже нет */ }
  return {c: c, calls: calls, st: st};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms || 30));
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; } };

const BARE3 = 'кофейни\nцветы\n\nстоматологии';           // с пустой строкой в середине
const CSV_CARD = '\uFEFFbusiness_oid;seoname;extra_col\r\n' +
                 '"1122446688";"kofeynya ""u petra""";x\r\n' +
                 '1099887766;bar-na-uglu;\r\n';
// строка без одного из идентификаторов — сервер требует оба, ловим на экране
const CSV_CARD_HALF = 'business_oid;seoname\n1099887766;\n';
const setText = (c, text) => vals(c).setText({target: {value: text}});

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {

  // Холостая отрисовка: renderVals() не падает, «Запустить» заблокирован, выгрузок нет.
  {
    const {c} = build();
    const v = vals(c);
    check('N0 renderVals() на пустом экране не падает', !v.__err);
    check('N0 без строк «Запустить» disabled, выгрузки disabled',
          v.runDisabled === true && v.dlDisabled === true && v.dlBg === '#8A8F9E',
          JSON.stringify([v.runDisabled, v.dlDisabled]));
  }

  // N1. Разбор CSV: BOM, разделитель «;», кавычки с удвоением, лишняя колонка.
  {
    const {c, calls} = build();
    vals(c).kinds[1].pick();
    setText(c, CSV_CARD);
    let v = vals(c);
    check('N1 CSV (;, кавычки "", BOM): разобрано 2 строк',
          v.parseOk === true && v.parseSummary === 'разобрано 2 строк',
          JSON.stringify([v.parseSummary, v.parseErrors]));
    check('N1 лишняя колонка перечислена и не отправляется',
          v.hasIgnored === true && /extra_col/.test(v.ignoredCols),
          v.ignoredCols);
    check('N1 обе строки полные — красных нет',
          v.hasParseErrors === false);
    await vals(c).doRun(); await sleep();
    check('N1 POST /intel/yandex ровно 1', calls.post.length === 1 &&
          calls.post[0].p === '/intel/yandex', JSON.stringify(calls.post.map((p) => p.p)));
    check('N1 тело: кавычки развёрнуты, пустые поля выброшены',
          JSON.stringify(calls.post[0].body) === JSON.stringify({
            kind: 'card',
            rows: [{business_oid: '1122446688', seoname: 'kofeynya "u petra"'},
                   {business_oid: '1099887766', seoname: 'bar-na-uglu'}]}),
          JSON.stringify(calls.post[0].body));
  }

  // N1b. card без seoname: сервер требует оба идентификатора — ловим на экране.
  {
    const {c} = build();
    vals(c).kinds[1].pick();
    setText(c, CSV_CARD_HALF);
    const v = vals(c);
    check('N1b card без seoname — красная строка, запуск заблокирован',
          v.hasParseErrors === true && /нет поля seoname/.test(v.parseErrors[0].t) &&
          v.runDisabled === true,
          JSON.stringify(v.parseErrors));
  }

  // N2. Разбор JSON-массива: числа приводятся, ошибка строки — с номером и причиной.
  {
    const {c, calls} = build();
    vals(c).kinds[2].pick();
    setText(c, '[{"business_oid": "1332211445", "seoname": "bar-na-uglu", "max_count": "30"}]');
    await vals(c).doRun(); await sleep();
    const row = calls.post[0] && calls.post[0].body.rows[0];
    check('N2 JSON: max_count "30" ушёл числом, business_oid строкой цифр',
          !!row && row.max_count === 30 && typeof row.max_count === 'number' &&
          row.business_oid === '1332211445',
          JSON.stringify(calls.post[0] && calls.post[0].body));

    const bad = build();
    vals(bad.c).kinds[0].pick();
    setText(bad.c, '[{}, {"query": "   "}]');
    const vb = vals(bad.c);
    check('N2 JSON без query: красные строки «строка N: нет поля query», запуск заблокирован',
          vb.hasParseErrors === true &&
          vb.parseErrors[0].t === 'строка 1: нет поля query' &&
          vb.parseErrors[1].t === 'строка 2: нет поля query' &&
          vb.runDisabled === true,
          JSON.stringify(vb.parseErrors));
  }

  // N3. Голые строки для extract: без заголовка, каждая строка = {query},
  // пустые строки пропускаются. Тот же текст для card — ошибка «нет заголовка».
  {
    const {c, calls} = build();
    setText(c, BARE3);
    let v = vals(c);
    check('N3 голые строки extract: разобрано 3 строк',
          v.parseOk === true && v.parseSummary === 'разобрано 3 строк',
          JSON.stringify([v.parseSummary, v.parseErrors]));
    await vals(c).doRun(); await sleep();
    check('N3 тело: три строки {query}, пустая строка пропущена',
          JSON.stringify(calls.post[0].body) === JSON.stringify({
            kind: 'extract',
            rows: [{query: 'кофейни'}, {query: 'цветы'}, {query: 'стоматологии'}]}),
          JSON.stringify(calls.post[0].body));

    const card = build();
    vals(card.c).kinds[1].pick();
    setText(card.c, BARE3);
    v = vals(card.c);
    check('N3 голые строки для card — ошибка «нет заголовка»',
          v.hasParseErrors === true && /нет заголовка/.test(v.parseErrors[0].t),
          JSON.stringify(v.parseErrors));
  }

  // N4. Блокировка «Запустить»: 0 строк и >50 строк; на 50 — активна.
  {
    const {c} = build();
    check('N4 0 строк — «Запустить» заблокирована', vals(c).runDisabled === true);
    setText(c, Array.from({length: 51}, (_, i) => 'запрос ' + (i + 1)).join('\n'));
    check('N4 51 строка — заблокирована, итог разбора объясняет лимит',
          vals(c).runDisabled === true &&
          /не больше 50/.test(vals(c).parseSummary),
          vals(c).parseSummary);
    setText(c, Array.from({length: 50}, (_, i) => 'запрос ' + (i + 1)).join('\n'));
    check('N4 ровно 50 строк — активна', vals(c).runDisabled === false);
  }

  // N5. Запуск по фикстуре: тело, спиннер-текст в полёте (местный тикер, не
  // доходит до N), таблица 3 строки — одна красная captcha, сводка, раскрытие.
  {
    const {c, calls, st} = build({hold: true});
    setText(c, BARE3);
    const running = vals(c).doRun(); // не ждём — ответ держим
    await sleep(30);
    let v = vals(c);
    check('N5 в полёте: кнопка заблокирована, «идёт: строка 1 из 3»',
          v.busy === true && v.runDisabled === true &&
          v.busyLabel === 'идёт: строка 1 из 3',
          JSON.stringify([v.busy, v.busyLabel]));
    await sleep(500);
    v = vals(c);
    check('N5 тикер доходит только до N-1 («строка 2 из 3»), завершения не обещает',
          v.busyAt === 2 && v.busyLabel === 'идёт: строка 2 из 3', v.busyLabel);
    check('N5 в полёте итога ещё нет', v.hasSummary === false && v.hasRows === false);
    st.resolvePost();
    await running; await sleep();
    v = vals(c);
    check('N5 после ответа: сводка «готово 2, ошибок 1»',
          v.busy === false && v.hasSummary === true &&
          v.summaryLabel === 'готово 2, ошибок 1',
          JSON.stringify([v.busy, v.summaryLabel]));
    check('N5 таблица: 3 строки, колонки extract (с «Организаций»)',
          v.hasRows === true && v.rows.length === 3 &&
          JSON.stringify(v.cols) === JSON.stringify(['#', 'Запрос', 'Статус', 'Организаций']),
          JSON.stringify(v.cols));
    check('N5 ok-строки зелёные, с числом организаций из фикстуры (2 и 1)',
          v.rows[0].cells[2].t === 'ok' && v.rows[0].cells[2].c === '#2E7D57' &&
          v.rows[0].cells[3].t === '2' && v.rows[1].cells[3].t === '1',
          JSON.stringify(v.rows.map((r) => r.cells.map((x) => x.t))));
    check('N5 третья строка красная: код captcha и текст сервера',
          v.rows[2].cells[2].c === '#DA501C' &&
          v.rows[2].cells[2].t === 'captcha — Яндекс показал капчу — повторите позже' &&
          v.rows[2].cells[3].t === '—',
          v.rows[2].cells[2].t);
    check('N5 ключевое поле extract — query из входа',
          v.rows[0].cells[1].t === 'кофейни' && v.rows[2].cells[1].t === 'стоматологии',
          JSON.stringify(v.rows.map((r) => r.cells[1].t)));

    v.rows[1].open(); await sleep();
    v = vals(c);
    check('N5 клик по строке раскрывает <pre> с data (JSON организаций)',
          v.hasDetail === true && v.detailText.indexOf('{') === 0 &&
          /stomatologiya_test/.test(v.detailText),
          v.detailText.slice(0, 80));
    v.rows[2].open(); await sleep();
    v = vals(c);
    check('N5 клик по красной строке — текст ошибки «captcha: …»',
          v.detailText === 'captcha: Яндекс показал капчу — повторите позже',
          v.detailText);
    v.rows[2].open(); await sleep();
    check('N5 повторный клик сворачивает <pre>', vals(c).hasDetail === false);
  }

  // N6. Выгрузки: JSON — весь ответ как есть; CSV — RFC 4180, пустые поля,
  // BOM; имена yandex-<kind>-<ГГГГММДД-ЧЧмм>.
  {
    const {c, calls} = build();
    setText(c, BARE3);
    await vals(c).doRun(); await sleep();
    let v = vals(c);
    check('N6 после ответа с ok-строками выгрузки активны',
          v.dlDisabled === false && v.dlBg === '#156479');
    v.dlCsv(); v.dlJson(); await sleep();
    const csvA = calls.anchors[0], jsonA = calls.anchors[1];
    check('N6 имена файлов yandex-extract-<ГГГГММДД-ЧЧмм>.csv/.json',
          /^yandex-extract-\d{8}-\d{4}\.csv$/.test(csvA.download) &&
          /^yandex-extract-\d{8}-\d{4}\.json$/.test(jsonA.download),
          JSON.stringify([csvA.download, jsonA.download]));
    const csv = calls.blobs[0].parts[0];
    check('N6 CSV начинается с BOM', csv.indexOf('\uFEFF') === 0);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    check('N6 CSV: шапка дословно по колонкам extract',
          lines[0] === 'query,name,address,phone,url,rating,reviews_count,business_oid,seoname,lat,lon',
          lines[0]);
    check('N6 CSV: по строке на организацию (3 строки данных)',
          lines.length === 4, 'строк: ' + lines.length);
    check('N6 CSV: запятые внутри адреса — в кавычках',
          lines[1] === 'кофейни,Кофейня «Пример»,"Санкт-Петербург, Невский проспект, 1",' +
                       '+7 812 000-00-00,https://kofeynya-primer.example,4.5,128,' +
                       '1122446688,kofeynya_primer,59.9356,30.3258',
          lines[1]);
    check('N6 CSV: отсутствующие phone/url остаются пустыми полями',
          lines[2] === 'кофейни,Пекарня «Образец»,"Санкт-Петербург, Гороховая улица, 2",,,' +
                       '4.1,41,1099887766,pekarnya_obrazets,59.9301,30.3378',
          lines[2]);
    check('N6 CSV: query берётся из строки входа',
          lines[3].indexOf('цветы,') === 0 && lines[4] === undefined, lines[3]);
    const json = JSON.parse(calls.blobs[1].parts[0]);
    check('N6 JSON — весь ответ как есть (дословно из фикстуры)',
          JSON.stringify(json) === JSON.stringify(YANDEX));

    // Мутация: запятая и кавычка внутри значения — кавычки удваиваются.
    const q = build({resp: (() => {
      const r = clone(YANDEX);
      r.results[0].data.organizations[0].name = 'Кофейня, "Пример"';
      r.results[0].data.organizations[0].phone = '+7 812 000-00-00, доб. 9';
      return r;
    })()});
    setText(q.c, BARE3);
    await vals(q.c).doRun(); await sleep();
    vals(q.c).dlCsv(); await sleep();
    const qline = q.calls.blobs[0].parts[0].replace(/^\uFEFF/, '').split('\r\n')[1];
    check('N6 мутация: кавычка удваивается, поле с запятой и кавычкой — в кавычках',
          qline === 'кофейни,"Кофейня, ""Пример""","Санкт-Петербург, Невский проспект, 1",' +
                    '"+7 812 000-00-00, доб. 9",https://kofeynya-primer.example,4.5,128,' +
                    '1122446688,kofeynya_primer,59.9356,30.3258',
          qline);
  }

  // N7. 409 — ключ Intel не заведён: подсказка про «Ключ Intel» (клик по ней
  // ведёт на экран ключа), экран жив и снова готов к запуску; тоста ошибки нет.
  {
    const {c, calls} = build({fail409: true});
    vals(c).kinds[1].pick();
    setText(c, CSV_CARD);
    await vals(c).doRun(); await sleep();
    let v = vals(c);
    check('N7 после 409 — подсказка про ключ показана',
          v.needKey === true && v.busy === false,
          JSON.stringify([v.needKey, v.busy]));
    vals(c).goKey(); await sleep();
    check('N7 клик по подсказке ведёт на экран «Ключ Intel» (go в журнале)',
          calls.go.indexOf('intel_key') !== -1, JSON.stringify(calls.go));
    v = vals(c);
    check('N7 экран жив: кнопки снова активны, тостов нет',
          !v.__err && v.runDisabled === false && v.busy === false &&
          calls.toasts.length === 0,
          JSON.stringify([v.runDisabled, calls.toasts]));
    check('N7 ответа нет — таблица не рисовалась', v.hasRows === false);
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
