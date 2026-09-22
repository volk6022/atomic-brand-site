// Поведенческая проверка экрана «Яндекс-карты» (RadarIntelYandex.dc.html) —
// по образцу check-intel.js: настоящий блок логики экрана исполняется под
// записывающим API, кнопки нажимаются по-настоящему. Значения ответа —
// дословно из `api-fixtures.json`: «POST /intel/yandex» (3 строки extract,
// одна красная с captcha) и настоящие формы card/reviews в соседних ключах
// «…[card]»/«…[reviews]» — всё сведено к продовой форме из
// _SAMPLES-yandex.json. Это контракт: правится экран, а не файл.
//
// Что проверяется (по задачам _TASK-yandex-maps-gui.md и _TASK-yandex-real-shape.md):
//   • разбор входа: CSV с «;», с кавычками (удвоение) и с BOM; JSON-массив;
//     голые строки без заголовка для extract (строка = {query});
//   • сборка CSV на выходе по настоящим полям ответа: extract — phones по
//     number и categories по name через «; », lat/lon из coordinates,
//     site null / нет coordinates и phones — пустые ячейки; card —
//     social_links «type: readableHref»; reviews — author из author.name;
//     экранирование RFC 4180, пустые поля остаются пустыми, BOM в начале;
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
const YANDEX_CARD = fixtures['POST /intel/yandex [card]'];
const YANDEX_REVIEWS = fixtures['POST /intel/yandex [reviews]'];

if (!YANDEX || !Array.isArray(YANDEX.results) || YANDEX.results.length !== 3 ||
    !YANDEX_CARD || !YANDEX_REVIEWS) {
  console.error('нет образцов «POST /intel/yandex» в api-fixtures.json ' +
                '(3 строки extract, одна с error.code captcha; рядом [card] и [reviews])');
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
          /6077001327/.test(v.detailText),
          v.detailText.slice(0, 80));
    v.rows[2].open(); await sleep();
    v = vals(c);
    check('N5 клик по красной строке — текст ошибки «captcha: …»',
          v.detailText === 'captcha: Яндекс показал капчу — повторите позже',
          v.detailText);
    v.rows[2].open(); await sleep();
    check('N5 повторный клик сворачивает <pre>', vals(c).hasDetail === false);
  }

  // N6. Выгрузки: JSON — весь ответ как есть; CSV — настоящие поля ответа
  // (extract: phones по number, categories по name, lat/lon из coordinates,
  // site null → пусто), RFC 4180, пустые поля, BOM; имена yandex-<kind>-<…>.
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
    check('N6 CSV: шапка дословно по настоящим полям extract',
          lines[0] === 'query,oid,seoname,title,address,phones,site,categories,' +
                       'rating,ratingCount,reviewsCount,status,lat,lon',
          lines[0]);
    check('N6 CSV: по строке на организацию (3 строки данных)',
          lines.length === 4, 'строк: ' + lines.length);
    check('N6 CSV: phones по number и адрес с запятой — в кавычках, site null — пусто',
          lines[1] === 'кофейни,10847347823,sibaristica,Sibaristica,' +
                       '"наб. Обводного канала, 199-201К","+7 (812) 309-42-16, доб. 3",,' +
                       'Кофейня; кафе,5,3923,1901,open,59.910412,30.284159',
          lines[1]);
    check('N6 CSV: categories по name, координаты из coordinates',
          lines[2] === 'кофейни,106360233783,baggins_coffee,Baggins Coffee,' +
                       '"Лиговский просп., 119",8 (800) 600-70-15,,Кофейня,' +
                       '4.699999809265137,340,188,open,59.91879,30.35244',
          lines[2]);
    check('N6 CSV: query берётся из строки входа',
          lines[3] === 'цветы,6077001327,baggins_coffee,Baggins Coffee,' +
                       '"Большая Пушкарская ул., 22",8 (800) 600-70-15,,' +
                       'Кофейня; магазин кофе; кофе с собой,5,236,201,open,59.958194,30.302408',
          lines[3]);
    const json = JSON.parse(calls.blobs[1].parts[0]);
    check('N6 JSON — весь ответ как есть (дословно из фикстуры)',
          JSON.stringify(json) === JSON.stringify(YANDEX));

    // Мутация: запятая и кавычка внутри значения — кавычки удваиваются.
    const q = build({resp: (() => {
      const r = clone(YANDEX);
      r.results[0].data.organizations[0].title = 'Кофейня, "Пример"';
      r.results[0].data.organizations[0].phones = [{number: '+7 812 000-00-00, доб. 9'}];
      return r;
    })()});
    setText(q.c, BARE3);
    await vals(q.c).doRun(); await sleep();
    vals(q.c).dlCsv(); await sleep();
    const qline = q.calls.blobs[0].parts[0].replace(/^\uFEFF/, '').split('\r\n')[1];
    check('N6 мутация: кавычка удваивается, поле с запятой и кавычкой — в кавычках',
          qline === 'кофейни,10847347823,sibaristica,"Кофейня, ""Пример""",' +
                    '"наб. Обводного канала, 199-201К","+7 812 000-00-00, доб. 9",,' +
                    'Кофейня; кафе,5,3923,1901,open,59.910412,30.284159',
          qline);

    // Организация без coordinates и без phones не ломает CSV: пустые ячейки.
    const bare = build({resp: (() => {
      const r = clone(YANDEX);
      delete r.results[0].data.organizations[0].coordinates;
      delete r.results[0].data.organizations[0].phones;
      return r;
    })()});
    setText(bare.c, BARE3);
    await vals(bare.c).doRun(); await sleep();
    vals(bare.c).dlCsv(); await sleep();
    const bline = bare.calls.blobs[0].parts[0].replace(/^\uFEFF/, '').split('\r\n')[1];
    check('N6 организация без coordinates и phones: пустые lat/lon/phones, CSV цел',
          bline === 'кофейни,10847347823,sibaristica,Sibaristica,' +
                    '"наб. Обводного канала, 199-201К",,,Кофейня; кафе,5,3923,1901,open,,',
          bline);
  }

  // N6b. Выгрузки card/reviews по настоящим формам data.card и data.reviews:
  // social_links «type: readableHref», author из author.name, объект — JSON,
  // null (hours, businessComment) — пустая ячейка.
  {
    const card = build({resp: YANDEX_CARD});
    vals(card.c).kinds[1].pick(); // режим «Карточка»
    setText(card.c, CSV_CARD);
    await vals(card.c).doRun(); await sleep();
    vals(card.c).dlCsv(); await sleep();
    const cardCsv = card.calls.blobs[0].parts[0].replace(/^\uFEFF/, '').split('\r\n');
    check('N6b card CSV: шапка дословно по настоящим полям card',
          cardCsv[0] === 'oid,seoname,title,description,phones,social_links,hours,rating,reviews_count',
          cardCsv[0]);
    check('N6b card CSV: описание с запятой — в кавычках, social_links «type: readableHref», hours null — пусто',
          cardCsv[1] === '10847347823,sibaristica,Sibaristica,' +
                         '"Санкт-Петербург, наб. Обводного канала, 199-201К",' +
                         '+7 (812) 309-42-16,' +
                         'telegram: @sibaristica_coffee; vkontakte: vk.ru/sibaristica,,5,1901',
          cardCsv[1]);

    const rev = build({resp: YANDEX_REVIEWS});
    vals(rev.c).kinds[2].pick(); // режим «Отзывы»
    setText(rev.c, '[{"business_oid": "10847347823", "seoname": "sibaristica"}]');
    await vals(rev.c).doRun(); await sleep();
    vals(rev.c).dlCsv(); await sleep();
    const revCsv = rev.calls.blobs[0].parts[0].replace(/^\uFEFF/, '').split('\r\n');
    check('N6b reviews CSV: шапка дословно по настоящим полям reviews',
          revCsv[0] === 'businessId,reviewId,author,rating,updatedTime,text,businessComment',
          revCsv[0]);
    check('N6b reviews CSV: author из author.name, businessId/reviewId/rating/updatedTime из отзыва',
          revCsv.length === 3 &&
          revCsv[1].indexOf('10847347823,RK9wPolZWZQO2WPXDtxuCRE87MFL9h,' +
                            'Squirrel07,5,2026-05-10T17:46:46.361Z,"Отличный кофе.') === 0 &&
          revCsv[2].indexOf('10847347823,_s5d7AxpDEL-HBCXtRM0Ocph4uq0ZAMz5,' +
                            'Светлана Бубнова,5,2026-09-21T17:56:45.411Z,"Классное,') === 0,
          JSON.stringify(revCsv.map((l) => l.slice(0, 90))));
    check('N6b reviews CSV: businessComment-объект — JSON в кавычках, null — пустая ячейка',
          revCsv[1].endsWith('}"') && revCsv[2].endsWith('",'),
          JSON.stringify([revCsv[1].slice(-40), revCsv[2].slice(-40)]));
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
