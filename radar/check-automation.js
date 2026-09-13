// Поведенческая проверка экрана «Автоматика» — блок Г из TESTS-autoflow-gui.md.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики
// по фикстурам. Ни тот, ни другой не нажимает кнопки и не сверяет словари.
// Главные риски экрана: перепутанный словарь статусов (canceled очереди против
// cancelled прогонов), POST полным словарём вместо изменившихся ключей,
// кнопка сохранения у не-владельца. Здесь логика экрана исполняется под
// записывающим API и сверяется: ЧТО спрошено, ЧТО нарисовано, ЧТО отправлено.
// Контракт: правится экран, а не файл.
//
//   node check-automation.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarAutomation.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const LIST = fixtures['/automation'];
const SAVE_ACK = fixtures['POST /automation/settings'];
if (!LIST || !LIST.scenarios || typeof LIST.scenarios !== 'object' ||
    !LIST.settings || !SAVE_ACK || !SAVE_ACK.settings) {
  console.error('нет образца GET /automation (scenarios+settings) или POST /automation/settings. Снимем прогоном dump_gui_fixtures или верни ключ из §5.2 CONTRACT-autoflow-gui.md');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], post: [], go: [], toasts: [], subs: [], unsubs: [],
                 timers: [], cleared: []};

  const api = {
    role: opts.role || 'owner',
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}}); // отказ тоже записываем: запрос был
      if (opts.failGets > 0) { opts.failGets--; throw new Error('база недоступна'); }
      if (p === '/automation') return clone(opts.list || LIST);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => {
      calls.post.push({p: p, body: body || {}});
      if (opts.postDetail) {
        const e = new Error('/automation/settings → 422');
        e.status = 422;
        e.body = {detail: opts.postDetail};
        throw e;
      }
      return clone(SAVE_ACK);
    },
    // Человеческий текст отказа — как radar-api.describe: сначала detail.
    describe: (e) => (e && e.body && e.body.detail) ? String(e.body.detail)
      : ((e && e.message) ? String(e.message) : String(e)),
    toast: (t, c) => calls.toasts.push({t: t, c: c}),
    go: (r) => calls.go.push(r),
    modal: () => {},
    events: {on: (name, fn) => { calls.subs.push({name: name, fn: fn});
                                return () => { calls.unsubs.push(name); }; }},
  };

  // Таймеры — моки: реальный setTimeout() не позволил бы ни проверить
  // «перечитывает по таймеру», ни удержать процесс коротким.
  const ctx = {
    console, URLSearchParams, Date, Math, JSON, RegExp,
    setTimeout: (fn, ms) => { calls.timers.push({fn: fn, ms: ms});
                              return calls.timers.length; },
    clearTimeout: (id) => { calls.cleared.push(id); },
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    window: {addEventListener() {}, removeEventListener() {}, open() {}},
    __imp: async () => api,
    __api: api,
  };
  vm.createContext(ctx);

  const base = `
    class DCLogic {
      constructor(){ this.props = {api: __api, mobile: false}; }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }
const row = (v, key) => (v.rows || []).find((r) => r.key === key);
const srow = (v, key) => (v.settingsRows || []).find((s) => s.key === key);
// Дата дд.мм чч:мм — та же формула, что у экрана: сверяем формат, не зону.
const whenOf = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {
  const SC = LIST.scenarios;

  // G-20. До загрузки экран обязан отдавать ВСЕ дырки разметки — и не путать
  // «загружаю» с «пусто»: отсутствующий ключ в этом фреймворке молча оставляет
  // пустую ячейку, а isEmpty при загрузке назвал бы рабочий экран пустым.
  {
    const {c} = build();
    const v = vals(c);
    check('G-20 renderVals() до загрузки не падает', !v.__err);
    check('G-20 до загрузки есть все ключи разметки',
          ['desktop', 'isMobile', 'reload', 'loading', 'hasError', 'errorMsg',
           'hasRows', 'isEmpty', 'cols', 'rows', 'cancelNote', 'emptyTitle',
           'emptyNote', 'hasSettings', 'settingsRows', 'isOwner', 'notOwner',
           'settingsHint', 'canSave', 'save'].every((k) => k in v));
    check('G-20 «загружаю» — не «пусто»: isEmpty === false и hasRows === false',
          v.isEmpty === false && v.hasRows === false);
  }

  // G-21. Первый запрос — GET /automation без параметров: у ручки нет ни
  // срезов, ни пагинации, и Table здесь не заводится вовсе.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    check('G-21 первый и единственный запрос — GET /automation',
          calls.get.length === 1 && calls.get[0].p === '/automation');
    check('G-21 без параметров: limit/offset не шлются',
          !!calls.get[0] && !('limit' in calls.get[0].q) && !('offset' in calls.get[0].q));
  }

  // G-22. Строки — по ключам scenarios в порядке экрана (ревью п.1: сервер
  // присылает объект без названий и порядка); лишний ключ — в конец.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-22 строк столько, сколько сценариев прислал сервер',
          v.rows.length === Object.keys(SC).length);
    check('G-22 порядок строк: join_backfill, reclassify, autoscan, autoapprove',
          v.rows.map((r) => r.key).join(',') === 'join_backfill,reclassify,autoscan,autoapprove');
    check('G-22 имя первого сценария — название экрана дословно',
          v.rows[0].name === 'Вступил → дочитал');
    check('G-22 параметры строки — одной строкой «ключ значение · …»',
          row(v, 'join_backfill').paramsLine ===
          'autoflow_backfill_depth_days 30 · autoflow_backfill_target 2000');
    check('G-22 в фикстуре все сценарии выключены — все бейджи «выключен»',
          v.rows.every((r) => r.onLabel === 'выключен' && r.onC === '#8A8F9E'));

    // Оба значения бейджа — мутацией стенда, не выдумкой.
    const mixed = clone(LIST);
    mixed.scenarios.join_backfill.enabled = true;
    mixed.scenarios.reclassify.enabled = true;
    const c2 = build({list: mixed}).c;
    await c2.componentDidMount();
    await sleep();
    const v2 = vals(c2);
    check('G-22 включённый сценарий — «включён» цветом #2E7D57',
          row(v2, 'join_backfill').onLabel === 'включён' &&
          row(v2, 'join_backfill').onC === '#2E7D57' &&
          row(v2, 'reclassify').onLabel === 'включён' &&
          row(v2, 'autoscan').onLabel === 'выключен');

    // Лишний ключ сервера не выбрасывается и не выдумывается: он в конце,
    // назван самим собой.
    const extra = clone(LIST);
    extra.scenarios.mystery = clone(extra.scenarios.autoscan);
    const c3 = build({list: extra}).c;
    await c3.componentDidMount();
    await sleep();
    const v3 = vals(c3);
    check('G-22 лишний ключ — последняя строка с ключом вместо названия',
          v3.rows.length === 5 &&
          v3.rows[4].key === 'mystery' && v3.rows[4].name === 'mystery');

    // Дополнительные поля сценариев — в подписи, формат «сегодня N из M» —
    // там, где потолок лежит в params.
    check('G-22+ join_backfill: подпись очереди от автоматики',
          row(v, 'join_backfill').note === 'в очереди от автоматики: 1' &&
          row(v, 'join_backfill').hasNote === true);
    check('G-22+ reclassify: подпись ждущих',
          row(v, 'reclassify').note.indexOf('ждут каналов: 0') >= 0 &&
          row(v, 'reclassify').note.indexOf('сообщений: 0') >= 0);
    check('G-22+ autoscan: доноры и метка дня',
          row(v, 'autoscan').note.indexOf('доноров: 0') >= 0 &&
          row(v, 'autoscan').note.indexOf('сегодня ещё не искали') >= 0);
    check('G-22+ autoapprove: «сегодня 0 из 3» по потолку из params',
          row(v, 'autoapprove').note.indexOf('сегодня 0 из 3') >= 0);
  }

  // G-23. Статусы прогонов — только словарём Runs (RadarRuns). Словарь очереди
  // (canceled одной l, «отменено») сюда просачиваться не должен.
  {
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-23 status done из фикстуры — «готово»',
          row(v, 'reclassify').runStatus === 'готово');
    check('G-23 дата прогона — дд.мм чч:мм от finished_at',
          row(v, 'reclassify').runWhen === whenOf(SC.reclassify.last_run.finished_at));
    check('G-23 имя прогона дословно из фикстуры',
          row(v, 'reclassify').runName === 'Переклассификация · недосчитанное · авто');

    const running = clone(LIST);
    running.scenarios.reclassify.last_run.status = 'running';
    const cr = build({list: running}).c;
    await cr.componentDidMount();
    await sleep();
    check('G-23 мутация стенда running → «выполняется»',
          row(vals(cr), 'reclassify').runStatus === 'выполняется');

    const cancelled = clone(LIST);
    cancelled.scenarios.reclassify.last_run.status = 'cancelled';
    const cc = build({list: cancelled}).c;
    await cc.componentDidMount();
    await sleep();
    check('G-23 мутация стенда cancelled → «остановлена»',
          row(vals(cc), 'reclassify').runStatus === 'остановлена');

    const labels = v.rows.map((r) => String(r.runStatus)).join('|');
    check('G-23 словаря очереди нет: строки подписей без «canceled» одной l',
          labels.indexOf('canceled') === -1 && labels.indexOf('отменено') === -1);
  }

  // G-24. Ячейка последнего запуска — ссылка в Runs; без прогона — текст без клика.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    const withRun = row(v, 'reclassify');
    check('G-24 у прогона ячейка кликабельна',
          withRun.hasRun === true && typeof withRun.openRuns === 'function');
    withRun.openRuns();
    check('G-24 клик зовёт api.go(\'runs\')', calls.go.join(',') === 'runs');
    const noRun = row(v, 'join_backfill');
    check('G-24 без прогона — «запусков не было» и клика нет',
          noRun.hasRun === false && noRun.noRun === true && noRun.openRuns === null);
  }

  // G-25. Ошибка показывается целиком — обрезка многоточием отправила бы
  // человека разбираться в сервере ровно тогда, когда текст нужнее всего.
  {
    const mutated = clone(LIST);
    mutated.scenarios.reclassify.last_run.error = 'текст отказа сервера';
    const {c} = build({list: mutated});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-25 ошибка последнего прогона в ячейке без обрезки',
          row(v, 'reclassify').hasErr === true &&
          row(v, 'reclassify').errText === 'текст отказа сервера');
    check('G-25 строки без ошибки показывают прочерк',
          row(v, 'autoscan').hasErr === false && row(v, 'autoscan').noErr === true);

    // Сценарная last_error (последний УПАВШИЙ, не последний прогон) — старше:
    // она сильнее ошибки последнего успешного прогона (ревью п.2).
    const lastErr = clone(LIST);
    lastErr.scenarios.reclassify.last_error = 'последний упавший';
    const c2 = build({list: lastErr}).c;
    await c2.componentDidMount();
    await sleep();
    check('G-25+ сценарная last_error сильнее ошибки последнего прогона',
          row(vals(c2), 'reclassify').errText === 'последний упавший');
  }

  // G-26. Владелец меняет одно числовое поле — POST один раз, тело из ОДНОГО
  // изменившегося ключа; после ответа перерисовка ИЗ ОТВЕТА (ревью п.4), без
  // перечитки GET: в ответе уже лежат действующие значения всех девяти ключей.
  {
    const {c, calls} = build({role: 'owner'});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('G-26 владелец: кнопка сохранения есть',
          v.isOwner === true && v.canSave === true);
    const input = srow(v, 'autoflow_reclassify_l3_limit');
    check('G-26 числовое поле — input со значением из фикстуры',
          !!input && input.isNum === true && input.value === '200' && input.disabled === false);
    input.onInput({target: {value: '300'}});
    v = vals(c);
    check('G-26 черновик видно в поле до сохранения',
          srow(v, 'autoflow_reclassify_l3_limit').value === '300' &&
          srow(v, 'autoflow_reclassify_l3_limit').cur === '300');
    await c.save();
    await sleep();
    check('G-26 POST /automation/settings ровно один раз',
          calls.post.length === 1 && calls.post[0].p === '/automation/settings');
    check('G-26 тело — только изменившийся ключ',
          JSON.stringify(calls.post[0].body) ===
          JSON.stringify({autoflow_reclassify_l3_limit: 300}));
    check('G-26 после ответа перечитки GET нет — перерисовка из ответа',
          calls.get.length === 1);
    v = vals(c);
    check('G-26 значения перерисованы из ответа POST (enabled=1 из ответа, не из GET)',
          srow(v, 'autoflow_reclassify_enabled').cur === '1' &&
          srow(v, 'autoflow_reclassify_enabled').chipLabel === 'вкл' &&
          srow(v, 'autoflow_reclassify_l3_limit').cur === '200');
    check('G-26 черновик очищен и тост успеха показан',
          srow(v, 'autoflow_reclassify_l3_limit').value === '200' &&
          srow(v, 'autoflow_reclassify_l3_limit').cur === '200' &&
          calls.toasts.some((t) => t.c === '#2E7D57'));
  }

  // G-27. Не-владелец: поля мертвы, кнопки нет, подсказка на месте, POST не
  // уходит даже при вызове save() напрямую.
  {
    const {c, calls} = build({role: 'customer'});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-27 у не-владельца кнопки «Сохранить» нет',
          v.isOwner === false && v.canSave === false);
    check('G-27 подсказка «Настройки автоматики меняет владелец» присутствует',
          v.notOwner === true && v.settingsHint === 'Настройки автоматики меняет владелец');
    check('G-27 все поля disabled, обработчиков нет',
          v.settingsRows.length > 0 &&
          v.settingsRows.every((s) => s.disabled === true &&
            typeof s.toggle !== 'function' && typeof s.onInput !== 'function'));
    await c.save();
    await sleep();
    check('G-27 POST не шлётся вовсе', calls.post.length === 0);
  }

  // G-28. Отказ записи — тост с текстом сервера (describe), состояние экрана
  // не роняется: это отказ сервера, а не поломка экрана.
  {
    const {c, calls} = build({role: 'owner',
      postDetail: 'autoflow_reclassify_interval_min: ожидалось от 5 до 1440, получено 0'});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    srow(v, 'autoflow_reclassify_interval_min').onInput({target: {value: '0'}});
    await c.save();
    await sleep();
    check('G-28 тост с текстом detail, цветом отказа',
          calls.toasts.some((t) => t.c === '#DA501C' &&
            /ожидалось от 5 до 1440/.test(t.t)));
    v = vals(c);
    check('G-28 экран жив: сводка на месте, красной рамки нет',
          v.hasError === false && v.rows.length === 4 && v.hasSettings === true);
  }

  // G-29. Пустой СПИСОК сценариев — пустое состояние экрана; пустой last_run
  // у отдельного сценария — нет (это «запусков не было» в ячейке, G-24).
  {
    const empty = clone(LIST);
    empty.scenarios = {};
    const {c} = build({list: empty});
    await c.componentDidMount();
    await sleep();
    const v = vals(c);
    check('G-29 пустой scenarios — пунктирная рамка «Автоматика ещё не настроена»',
          v.isEmpty === true && v.hasRows === false &&
          v.emptyTitle === 'Автоматика ещё не настроена');
    check('G-29 настройки при пустых сценариях показываются отдельно',
          v.hasSettings === true && v.settingsRows.length === 9);

    const c2 = build().c;
    await c2.componentDidMount();
    await sleep();
    check('G-29 сценарии без прогонов — НЕ пустое состояние экрана',
          vals(c2).isEmpty === false && vals(c2).hasRows === true);
  }

  // G-2A. Ошибка сети — красная рамка с текстом describe; «↻ обновить» лечит.
  {
    const {c, calls} = build({failGets: 1});
    await c.componentDidMount();
    await sleep();
    let v = vals(c);
    check('G-2A ошибка сети — hasError с текстом describe',
          v.hasError === true && v.errorMsg.indexOf('база недоступна') >= 0);
    check('G-2A при ошибке строк нет и «пусто» не рисуется',
          v.rows.length === 0 && v.isEmpty === false);
    v.reload();
    await sleep();
    v = vals(c);
    check('G-2A повтор по «↻ обновить» работает',
          v.hasError === false && v.rows.length === 4 && calls.get.length === 2);
  }

  // G-2B. Обновление: таймер 30 000 мс перечитывает; кадр runs перечитывает
  // сразу; размонтирование чистит таймер и отписку — после него GET нет.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    check('G-2B подписка на кадр runs заведена',
          calls.subs.length === 1 && calls.subs[0].name === 'runs');
    check('G-2B таймер поставлен ровно на 30 000 мс',
          calls.timers.length === 1 && calls.timers[0].ms === 30000);

    calls.timers[calls.timers.length - 1].fn();
    await sleep();
    check('G-2B удар таймера перечитывает /automation',
          calls.get.length === 2 && calls.timers.length === 2 &&
          calls.timers[1].ms === 30000);

    calls.subs[0].fn();
    await sleep();
    check('G-2B кадр runs перечитывает сразу, не ждёт таймера',
          calls.get.length === 3);

    const timerBefore = calls.timers.length;
    c.componentWillUnmount();
    check('G-2B размонтирование чистит таймер и отписывается',
          calls.cleared.length >= 1 &&
          calls.cleared[calls.cleared.length - 1] === timerBefore &&
          calls.unsubs.length === 1 && calls.unsubs[0] === 'runs');

    // И просроченные события/таймеры мёртвого компонента не дёргают.
    calls.subs[0].fn();
    calls.timers[calls.timers.length - 1].fn();
    await sleep();
    check('G-2B после размонтирования ни одного GET',
          calls.get.length === 3);
  }

  // G-2C. Надпись у ссылки на прогон — дословно (решение Ивана 12.09).
  {
    const fresh = vals(build().c);
    const {c} = build();
    await c.componentDidMount();
    await sleep();
    const loaded = vals(c);
    check('G-2C надпись про отмену дословно и до, и после загрузки',
          fresh.cancelNote === 'Отменить автоматический прогон может только владелец' &&
          loaded.cancelNote === 'Отменить автоматический прогон может только владелец');
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
