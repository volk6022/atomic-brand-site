// Скретч-проверка плашки «Интерфейс обновился» (оболочка, обе копии).
//
// Открытая вкладка держит тот код оболочки, который загрузился, и новые экраны
// приезжают только с перезагрузкой. Оболочка теперь сверяет метку версии
// index.html (HEAD-запрос: ETag, запас — Last-Modified) и при расхождении
// предлагает обновиться. Здесь эта механика прогоняется под подменённым fetch:
// запросы считаются, таймеры и слушатели — под контролем, location.reload
// заменён счётчиком (реальная перезагрузка в стенде убила бы проверку).
//
// По образцу check-routing.js: исполняется настоящий блок логики оболочки
// (<script type="text/x-dc">), сессии нет — "/auth/me" бросает, человек на
// форме входа; плашка к сессии не привязана, и это самый короткий монтаж.
//
//     node check-shell-update.js .
//
// Сценарии (а)–(е) — из задачи; (+) — детали того же поведения: запасная метка
// Last-Modified, выключение без заголовков, троттлинг visibilitychange.
// Проверяются ОБЕ копии оболочки: браузер исполняет index.html, а правят
// Atomic Radar.dc.html — сценарий, прошедший только на правленой копии, прод
// не чинит (см. check-shell-copy.js).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let DIR = path.resolve(process.argv[2] || '.');
if(!fs.existsSync(path.join(DIR, 'Atomic Radar.dc.html'))) DIR = __dirname;

const results = [];
function check(name, cond, why){ results.push([cond ? 'ok  ' : 'FAIL', name + (cond || !why ? '' : ' | ' + why)]); }
const flush = ()=>new Promise(r=>setTimeout(r, 5));

function logicOf(file){
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  if(!m) throw new Error(file + ': блока <script type="text/x-dc"> нет');
  return m[1];
}

// Стенд. Сервер для /radar/index.html описан объектом server — сценарии правят
// его между шагами (метка, код ответа, сеть).
function makeShell(logic, opts){
  opts = opts || {};
  const server = {
    etag: opts.etag !== undefined ? opts.etag : 'w/"v1"',
    lm: opts.lm !== undefined ? opts.lm : null,
    status: 200,
    fail: null,                       // 'network' — fetch бросает
  };
  const clock = {now: 1000000};       // Date.now под контролем — для троттлинга
  const heads = [];                   // каждый HEAD-запрос с его аргументами
  const intervals = [];               // {id, fn, ms} — сами не тикают
  const cleared = [];
  const reloads = {n: 0};
  const listeners = {};
  let nextId = 7;

  const headers = ()=>({get:(n)=>{
    const k = String(n).toLowerCase();
    if(k === 'etag') return server.etag;
    if(k === 'last-modified') return server.lm;
    return null;
  }});
  const fetchImpl = async (url, o)=>{
    heads.push({url, opts:o});
    if(server.fail === 'network') throw new Error('fetch failed');
    return {status:server.status, ok: server.status >= 200 && server.status < 300,
            headers:headers()};
  };

  const api = {
    get: async (p)=>{ if(p === '/auth/me') throw new Error('нет сессии');
                      throw new Error('нет образца: ' + p); },
    post: async ()=>({ok:true}),
    describe: (e)=>'ошибка: ' + e.message,
    isUnauthorized: ()=>false,
  };

  const ctx = {
    console,
    setTimeout, clearTimeout,        // настоящие: await flush() в сценариях
    setInterval:(fn, ms)=>{ const id = nextId++; intervals.push({id, fn, ms}); return id; },
    clearInterval:(id)=>{ cleared.push(id); },
    Date: {now:()=>clock.now},       // в логике оболочки Date больше нигде не нужен
    URLSearchParams, JSON, Math, RegExp,
    localStorage:{getItem:()=>null, setItem(){}},
    location:{hash:'', reload:()=>{ reloads.n++; }},
    history:{replaceState(){}},
    document:{visibilityState:'visible'},
    window:{
      addEventListener:(n,f)=>{ (listeners[n] = listeners[n] || []).push(f); },
      removeEventListener:(n,f)=>{ const a = listeners[n] || [];
        const i = a.indexOf(f); if(i !== -1) a.splice(i, 1); },
    },
    fetch: fetchImpl,
    __imp: async ()=>api,
  };
  vm.createContext(ctx);
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign({}, __props); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if(cb) cb();
      }
    }`;
  ctx.__props = {};
  const prepared = logic.replace(/await import\(/g, 'await __imp(');
  vm.runInContext(base + '\n' + prepared + '\n;this.__C = Component;', ctx);
  const C = ctx.__C;
  return {
    server, clock, heads, intervals, cleared, reloads, listeners,
    document: ctx.document,
    async mount(){
      const c = new C();
      await c.componentDidMount();   // /auth/me бросит — форма входа, это штатно
      await flush();                 // стартовый HEAD успел разрешиться
      return c;
    },
  };
}

async function scenarios(file){
  const label = file;
  const logic = logicOf(file);

  // (а) Первый HEAD запоминает ETag, плашки нет.
  {
    const env = makeShell(logic);
    const c = await env.mount();
    check('(а) ' + label + ': стартовый HEAD — ровно один',
          env.heads.length === 1, 'запросов: ' + env.heads.length);
    check('(а) ' + label + ': это HEAD /radar/index.html без кеша',
          env.heads[0].url === '/radar/index.html' && env.heads[0].opts.method === 'HEAD'
          && env.heads[0].opts.cache === 'no-store',
          JSON.stringify(env.heads[0]));
    check('(а) ' + label + ': ETag запомнен в состоянии оболочки',
          c.state.etag === 'w/"v1"', 'etag=' + c.state.etag);
    check('(а) ' + label + ': плашки нет',
          c.renderVals().updateReady === false);
    check('(а) ' + label + ': таймер поставлен на 3 минуты',
          env.intervals.length === 1 && env.intervals[0].ms === 3 * 60 * 1000,
          JSON.stringify(env.intervals.map(i=>i.ms)));
    check('(а) ' + label + ': слушатель visibilitychange повешен',
          (env.listeners.visibilitychange || []).length === 1);
  }

  // (б) Тот же ETag на следующей проверке — плашки нет. Второй шаг делает
  //     сам тик таймера: проверяем проводку интервал -> checkForUpdate.
  {
    const env = makeShell(logic);
    const c = await env.mount();
    await c.checkForUpdate(); await flush();
    check('(б) ' + label + ': та же метка — запрос был, плашки нет',
          env.heads.length === 2 && c.renderVals().updateReady === false,
          'запросов: ' + env.heads.length);
    env.intervals[0].fn(); await flush();
    check('(б) ' + label + ': тик таймера сверил метку — снова без плашки',
          env.heads.length === 3 && c.renderVals().updateReady === false,
          'запросов: ' + env.heads.length);
    check('(б) ' + label + ': базовая метка не перезаписана той же',
          c.state.etag === 'w/"v1"');
  }

  // (в) Другой ETag — плашка есть; кнопка зовёт перезагрузку; пока плашка
  //     поднята, проверка не ходит вовсе (не мигает и не учащает).
  {
    const env = makeShell(logic);
    const c = await env.mount();
    env.server.etag = 'w/"v2"';
    await c.checkForUpdate(); await flush();
    check('(в) ' + label + ': другая метка — плашка поднята',
          c.renderVals().updateReady === true && c.state.etag === 'w/"v1"',
          'updateReady=' + c.renderVals().updateReady);
    const before = env.heads.length;
    await c.checkForUpdate(); await flush();
    check('(в) ' + label + ': пока плашка поднята — новых запросов нет',
          env.heads.length === before, 'было ' + before + ', стало ' + env.heads.length);
    const r0 = env.reloads.n;
    c.renderVals().updateNow();
    check('(в) ' + label + ': «Обновить» зовёт location.reload()',
          env.reloads.n === r0 + 1, 'reload: ' + (env.reloads.n - r0));
  }

  // (г) Ошибка сети и 500 — плашки нет и ничего не падает.
  {
    const env = makeShell(logic, {etag:'w/"v1"'});
    env.server.fail = 'network';          // сеть лежит уже на старте
    let c = null;
    try { c = await env.mount(); } catch(e){ c = null; }
    check('(г) ' + label + ': старт при мёртвой сети не падает',
          !!c && c.state.etag === null && c.renderVals().updateReady === false);
    env.server.fail = null;               // сеть ожила
    await c.checkForUpdate(); await flush();
    check('(г) ' + label + ': первая удачная проверка ставит базовую метку, не плашку',
          c.state.etag === 'w/"v1"' && c.renderVals().updateReady === false,
          'etag=' + c.state.etag);

    const env2 = makeShell(logic);
    const c2 = await env2.mount();
    env2.server.status = 500;
    await c2.checkForUpdate(); await flush();
    check('(г) ' + label + ': 500 — молча, без плашки, база цела',
          c2.renderVals().updateReady === false && c2.state.etag === 'w/"v1"',
          'updateReady=' + c2.renderVals().updateReady);
  }

  // (д) «Потом» скрывает плашку; та же метка больше её не поднимает; следующий
  //     НОВЫЙ ETag показывает снова.
  {
    const env = makeShell(logic);
    const c = await env.mount();
    env.server.etag = 'w/"v2"';
    await c.checkForUpdate(); await flush();
    c.renderVals().updateLater(); await flush();
    check('(д) ' + label + ': «потом» спрятал плашку',
          c.renderVals().updateReady === false);
    await c.checkForUpdate(); await flush();
    check('(д) ' + label + ': та же метка после «потом» — плашка остаётся скрытой',
          c.renderVals().updateReady === false);
    env.server.etag = 'w/"v3"';
    await c.checkForUpdate(); await flush();
    check('(д) ' + label + ': следующий новый ETag показал плашку снова',
          c.renderVals().updateReady === true);
  }

  // (е) После размонтирования новых запросов нет: таймер снят, слушатель снят,
  //     и прямой вызов проверки, и старый обработчик — глухие.
  {
    const env = makeShell(logic);
    const c = await env.mount();
    const vis = env.listeners.visibilitychange[0];
    const n = env.heads.length;
    const timerId = env.intervals[0].id;
    c.componentWillUnmount();
    check('(е) ' + label + ': таймер снят',
          env.cleared.indexOf(timerId) !== -1, 'cleared: ' + JSON.stringify(env.cleared));
    check('(е) ' + label + ': слушатель visibilitychange снят',
          (env.listeners.visibilitychange || []).length === 0);
    await c.checkForUpdate(); await flush();
    check('(е) ' + label + ': checkForUpdate после размонтирования не шлёт запрос',
          env.heads.length === n, 'было ' + n + ', стало ' + env.heads.length);
    vis(); await flush();
    check('(е) ' + label + ': старый обработчик после размонтирования молчит',
          env.heads.length === n);
  }

  // (+) Запасная метка Last-Modified: работает так же, как ETag.
  {
    const env = makeShell(logic, {etag:null, lm:'Wed, 16 Sep 2026 09:00:00 GMT'});
    const c = await env.mount();
    check('(+) ' + label + ': без ETag запомнен Last-Modified',
          c.state.etag === 'Wed, 16 Sep 2026 09:00:00 GMT', 'etag=' + c.state.etag);
    env.server.lm = 'Wed, 16 Sep 2026 11:30:00 GMT';
    await c.checkForUpdate(); await flush();
    check('(+) ' + label + ': сменённый Last-Modified поднимает плашку',
          c.renderVals().updateReady === true);
  }

  // (+) Ни ETag, ни Last-Modified — механизм молча выключен: без таймера,
  //     без слушателя, без ошибок.
  {
    const env = makeShell(logic, {etag:null, lm:null});
    const c = await env.mount();
    check('(+) ' + label + ': без меток состояние пустое, плашки нет',
          c.state.etag === null && c.renderVals().updateReady === false);
    check('(+) ' + label + ': без меток таймер и слушатель не ставились',
          env.intervals.length === 0 && (env.listeners.visibilitychange || []).length === 0,
          JSON.stringify({timers:env.intervals.length,
                          vis:(env.listeners.visibilitychange || []).length}));
    await c.checkForUpdate(); await flush();
    check('(+) ' + label + ': проверка без механизма — тихо, плашки нет',
          c.renderVals().updateReady === false,
          'updateReady=' + c.renderVals().updateReady);
  }

  // (+) visibilitychange не чаще раза в 30 секунд; из фона проверка не ходит.
  {
    const env = makeShell(logic);
    const c = await env.mount();
    const vis = env.listeners.visibilitychange[0];
    const n = env.heads.length;
    vis(); await flush();
    check('(+) ' + label + ': возврат фокуса запускает проверку',
          env.heads.length === n + 1);
    vis(); await flush();
    check('(+) ' + label + ': повтор тут же — протоллён, запроса нет',
          env.heads.length === n + 1);
    env.clock.now += 31 * 1000;
    vis(); await flush();
    check('(+) ' + label + ': спустя полминуты проверка снова ходит',
          env.heads.length === n + 2);
    env.document.visibilityState = 'hidden';
    env.clock.now += 31 * 1000;
    vis(); await flush();
    check('(+) ' + label + ': уход вкладки в фон проверку не запускает',
          env.heads.length === n + 2);
    env.document.visibilityState = 'visible';
  }
}

(async ()=>{
  for(const file of ['Atomic Radar.dc.html', 'index.html']){
    try { await scenarios(file); }
    catch(e){ check('(×) ' + file + ': сценарий сорвался', false, e.message + ' / ' + (e.stack || '').split('\n')[1]); }
  }
  let bad = 0;
  for(const [st, name] of results){ console.log(st + ' ' + name); if(st === 'FAIL') bad++; }
  console.log(bad ? '--- ПРОВАЛОВ: ' + bad : '--- все проверки прошли');
  process.exit(bad ? 1 : 0);
})().catch(e=>{ console.error('сорвался: ' + e.stack); process.exit(2); });
