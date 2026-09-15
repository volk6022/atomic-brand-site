// Поведенческая проверка экрана Safety — перечитка состояния после kill-switch
// и после смены режима (PLAN 14.9 шаг 4: 14.8.21 + 14.8.8).
//
// Оболочка сама исполняет модалки live/dry/kill (post + refreshMode), экрану
// оставалось только ждать F5. Теперь оболочка зовёт m.after, а экран умеет
// перечитываться (load() без сброса показанного и без мигания заглушкой) и
// подстраховывается по componentDidUpdate, сравнивая значения api.mode/api.killed.
//
// Логика экрана исполняется в vm под записывающим api со стабами get/post/modal,
// по образцу check-automation.js. Образцы /limits и /system/mode — из
// api-fixtures.json (снят реальным прогоном, руками не пишется).
//
//   node check-safety.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarSafety.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const results = [];
function check(name, cond, why){ results.push([cond ? 'ok  ' : 'FAIL', name + (cond || !why ? '' : ' | ' + why)]); }

// Форма ответа /system/mode — то, на чём держится весь экран: effective_mode
// решает LIVE/DRY_RUN, killed — пилюлю «ОСТАНОВЛЕНО». Нет полей — стенд врёт.
const LIMITS = fixtures['/limits'];
const MODE = fixtures['/system/mode'];
if (!LIMITS || !Array.isArray(LIMITS.limits) ||
    !MODE || typeof MODE.effective_mode !== 'string' ||
    typeof MODE.killed !== 'boolean' || !('killed_reason' in MODE)) {
  console.error('нет образца GET /limits (limits[]) или GET /system/mode (effective_mode, killed, killed_reason). Снимем прогоном dump_gui_fixtures.');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], post: [], modal: []};
  // env.mode тест меняет между шагами: сервер ответил уже по-другому, а экран
  // об этом не знает, пока не перечитается. env.dead — «сеть легла» для (е).
  const env = {mode: clone(opts.mode || MODE), dead: false};
  const api = {
    role: opts.role || 'owner',
    // Как оболочка кладёт экрану: mode = effective_mode, killed = !!killed.
    mode: env.mode.effective_mode,
    killed: !!env.mode.killed,
    get: async (p) => {
      calls.get.push(p);
      if (env.dead) throw new Error('база недоступна');
      if (p === '/limits') return clone(opts.limits || LIMITS);
      if (p === '/system/mode') return clone(env.mode);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => { calls.post.push({p: p, body: body || {}}); return {ok: true}; },
    describe: (e) => (e && e.message) ? String(e.message) : String(e),
    modal: (m) => calls.modal.push(m),
    events: {on: () => () => {}},
  };

  const ctx = {
    console, URLSearchParams, Date, Math, JSON, RegExp,
    setTimeout: () => 0, clearTimeout(){},
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    window: {addEventListener(){}, removeEventListener(){}},
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
  vm.runInContext(base + '\n' + (opts.logic || logic).replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls: calls, api: api, env: env};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; }
const modeGets = (calls) => calls.get.filter((p) => p === '/system/mode').length;
const lastModal = (calls) => calls.modal[calls.modal.length - 1] || {};

// Сценарий (б) целиком — он же мутационный оракул для (з): дошёл ли kill
// через after до перечитки и до пилюли «ОСТАНОВЛЕНО».
async function killReachesReRead(src) {
  const {c, calls, env} = build({logic: src});
  await c.componentDidMount();
  await sleep();
  vals(c).kill();
  const m = lastModal(calls);
  if (m.kind !== 'kill' || typeof m.after !== 'function') return false;
  const killed = clone(MODE);
  killed.killed = true;                    // effective_mode НЕ меняется —
  killed.killed_reason = 'kill switch из интерфейса';  // только так и бывает (14.8.21)
  env.mode = killed;
  await m.after();
  await sleep();
  const v = vals(c);
  return modeGets(calls) >= 2 && v.pill.text === 'ОСТАНОВЛЕНО' &&
         v.btn.label === 'Снять аварийную остановку';
}

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {

  // (а) Монтирование: ровно два GET, режим DRY_RUN из фикстуры виден на экране.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await sleep();
    check('(а) монтирование: два GET — /limits и /system/mode',
          calls.get.length === 2 &&
          calls.get.indexOf('/limits') !== -1 && calls.get.indexOf('/system/mode') !== -1,
          JSON.stringify(calls.get));
    const v = vals(c);
    check('(а) DRY_RUN: пилюля «DRY RUN»',
          v.pill.text === 'DRY RUN' && v.pill.bg === '#131E5F', JSON.stringify(v.pill));
    check('(а) DRY_RUN: кнопка «Переключить в LIVE» с подсказкой про слово LIVE',
          v.btn.label === 'Переключить в LIVE' && /словом LIVE/.test(v.btn.hint),
          JSON.stringify(v.btn));
    check('(а) лимиты из фикстуры отрисованы',
          Array.isArray(v.limits) && v.limits.length === LIMITS.limits.length);
  }

  // (б) kill: модалка kind=kill с after; after при уже убитом сервере —
  //     перечитка /system/mode и пилюля «ОСТАНОВЛЕНО» без F5 (14.8.21).
  {
    const {c, calls, env} = build();
    await c.componentDidMount();
    await sleep();
    vals(c).kill();
    const m = lastModal(calls);
    check('(б) kill: модалка kind=kill с функцией after',
          m.kind === 'kill' && typeof m.after === 'function', JSON.stringify(m.kind));
    check('(б) kill: до подтверждения второй перечитки ещё не было',
          modeGets(calls) === 1);
    const killed = clone(MODE);
    killed.killed = true;
    killed.killed_reason = 'kill switch из интерфейса';
    env.mode = killed;
    await m.after();
    await sleep();
    check('(б) kill: after перечитал /system/mode', modeGets(calls) === 2,
          JSON.stringify(calls.get));
    const v = vals(c);
    check('(б) kill: пилюля «ОСТАНОВЛЕНО»',
          v.pill.text === 'ОСТАНОВЛЕНО' && v.pill.bg === '#DA501C' && v.pill.anim === 'none',
          JSON.stringify(v.pill));
    check('(б) kill: кнопка «Снять аварийную остановку» с подсказкой про DRY RUN',
          v.btn.label === 'Снять аварийную остановку' && /DRY RUN/.test(v.btn.hint),
          JSON.stringify(v.btn));
  }

  // (в) Переключение в LIVE: модалка kind=live с after; after при сервере,
  //     уже отвечающем LIVE, — пилюля «LIVE» без F5 (14.8.8).
  {
    const {c, calls, env} = build();
    await c.componentDidMount();
    await sleep();
    vals(c).toggleMode();
    const m = lastModal(calls);
    check('(в) toggleMode в DRY_RUN: модалка kind=live с after',
          m.kind === 'live' && typeof m.after === 'function', JSON.stringify(m.kind));
    check('(в) live: модалка требует ввода слова LIVE', m.word === 'LIVE');
    const live = clone(MODE);
    live.effective_mode = 'LIVE';
    env.mode = live;
    await m.after();
    await sleep();
    const v = vals(c);
    check('(в) live: пилюля «LIVE»',
          v.pill.text === 'LIVE' && /livepulse/.test(v.pill.anim), JSON.stringify(v.pill));
    check('(в) live: кнопка «Вернуть в сухой прогон»',
          v.btn.label === 'Вернуть в сухой прогон', JSON.stringify(v.btn));
  }

  // (г) Обратно: из LIVE модалка kind=dry с after — после неё снова DRY RUN.
  {
    const live = clone(MODE);
    live.effective_mode = 'LIVE';
    const {c, calls, env} = build({mode: live});
    await c.componentDidMount();
    await sleep();
    check('(г) стенд: смонтирован в LIVE', vals(c).pill.text === 'LIVE');
    vals(c).toggleMode();
    const m = lastModal(calls);
    check('(г) toggleMode в LIVE: модалка kind=dry с after',
          m.kind === 'dry' && typeof m.after === 'function', JSON.stringify(m.kind));
    env.mode = clone(MODE);
    await m.after();
    await sleep();
    const v = vals(c);
    check('(г) dry: пилюля «DRY RUN»', v.pill.text === 'DRY RUN', JSON.stringify(v.pill));
    check('(г) dry: кнопка «Переключить в LIVE»',
          v.btn.label === 'Переключить в LIVE', JSON.stringify(v.btn));
  }

  // (д) componentDidUpdate: страховка от рассинхрона с шапкой. api оболочка
  //     пересобирает на каждом рендере — срабатывает только смена ЗНАЧЕНИЙ.
  {
    const {c, api} = build();
    await c.componentDidMount();
    await sleep();
    const loads = [];
    const orig = c.load;
    c.load = function(){ loads.push(1); return orig.apply(this, arguments); };
    api.mode = 'DRY_RUN';
    api.killed = false;
    c.componentDidUpdate({api: {role: 'owner', mode: 'DRY_RUN', killed: false}});
    check('(д) тот же api по значениям (новый объект) — load() не зовётся',
          loads.length === 0, JSON.stringify(loads.length));
    api.killed = true;   // оболочка узнала о kill (refreshMode, кадр потока)
    c.componentDidUpdate({api: {role: 'owner', mode: 'DRY_RUN', killed: false}});
    check('(д) killed false→true при том же mode — load() вызван один раз',
          loads.length === 1, JSON.stringify(loads.length));
    c.componentDidUpdate({api: {role: 'owner', mode: 'DRY_RUN', killed: true}});
    check('(д) кадр без изменений — второго load() нет',
          loads.length === 1, JSON.stringify(loads.length));
  }

  // (е) Отказ перечитки: ошибка показана, уже показанные d/mode не сброшены.
  {
    const {c, env} = build();
    await c.componentDidMount();
    await sleep();
    const before = vals(c);
    check('(е) до отказа данные на экране',
          before.limits.length === LIMITS.limits.length && before.pill.text === 'DRY RUN');
    env.dead = true;
    await c.load();
    await sleep();
    const v = vals(c);
    check('(е) отказ перечитки: ошибка показана текстом describe',
          v.hasError === true && /база недоступна/.test(v.errorMsg),
          JSON.stringify({hasError: v.hasError, msg: v.errorMsg}));
    check('(е) отказ перечитки: прежние d/mode остались на экране',
          v.limits.length === LIMITS.limits.length &&
          v.pill.text === 'DRY RUN' && v.btn.label === 'Переключить в LIVE');
  }

  // (ж) resume — как работал, так и работает: свой post и своя перечитка.
  {
    const killed = clone(MODE);
    killed.killed = true;
    killed.killed_reason = 'kill switch из интерфейса';
    const {c, calls} = build({mode: killed});
    await c.componentDidMount();
    await sleep();
    check('(ж) стенд: смонтирован остановленным', vals(c).pill.text === 'ОСТАНОВЛЕНО');
    vals(c).toggleMode();
    const m = lastModal(calls);
    check('(ж) resume: модалка kind=resume с run',
          m.kind === 'resume' && typeof m.run === 'function', JSON.stringify(m.kind));
    const before = modeGets(calls);
    await m.run();
    await sleep();
    check('(ж) resume: post /system/resume ровно один раз',
          calls.post.length === 1 && calls.post[0].p === '/system/resume',
          JSON.stringify(calls.post));
    check('(ж) resume: после снятия остановки экран перечитал /system/mode',
          modeGets(calls) === before + 1, JSON.stringify(calls.get));
  }

  // (з) Мутация: убрать after у kill — проверка (б) обязана покраснеть.
  {
    check('(з) на живом экране kill доходит до перечитки',
          await killReachesReRead(logic) === true);
    const noAfter = logic.replace(/(kind:'kill'[\s\S]*?)after:\(\)=>this\.load\(\)/, '$1');
    check('(з) мутация: after у kill вырезан — сценарий краснеет',
          noAfter !== logic && await killReachesReRead(noAfter) === false);
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
