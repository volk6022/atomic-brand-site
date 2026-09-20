// Поведенческая проверка экрана диалогов.
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики.
// Ни тот, ни другой не нажимает на кнопки, а вся ценность этого экрана именно в
// нажатиях: открыть нитку, отметить прочитанным, вернуться к списку. Прошлый заход
// показал, чем это кончается — в таблице черновиков загрузка шла до применения
// среза из адреса, и ссылка открывала не то, что должна была. Проверки на такое
// не было, потому что её нечем было выразить.
//
// Здесь она есть. Файл исполняет настоящую логику экрана под записывающим API и
// сверяет, ЧТО экран запросил и КОГДА. Это контракт: правится экран, а не файл.
//
//   node check-conversations.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarConversations.dc.html', 'utf8');
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond) { results.push([cond ? 'ok  ' : 'FAIL', name]); }

const LIST = fixtures['/conversations'];
const THREAD = fixtures['/conversations/{id}'];
if (!LIST || !THREAD) {
  console.error('нет образцов ответа. Пересними: uv run python -m scripts.dump_gui_fixtures');
  process.exit(2);
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд ─────────────────────────────────────────────────────────────────────

function build(opts) {
  opts = opts || {};
  const calls = {get: [], post: []};
  const api = {
    get: async (p, q) => {
      calls.get.push({p: p, q: q || {}});
      if (p === '/conversations') return clone(opts.list || LIST);
      if (/^\/conversations\/\d+$/.test(p)) {
        if (opts.failThread) throw new Error('нитка недоступна');
        return clone(opts.thread || THREAD);
      }
      if (/\/reply-preflight$/.test(p)) {
        return clone(fixtures[opts.blocked ? '/conversations/{id}/reply-preflight:blocked'
                                           : '/conversations/{id}/reply-preflight']);
      }
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p, body) => {
      calls.post.push({p: p, body: body || {}});
      if (/\/read$/.test(p)) {
        return {id: Number(p.split('/')[2]), read_at: '2026-09-02T16:00:00', unread: false};
      }
      // Заглушки повторяют реальные ответы ручек 16.5 (память проекта: щедрая
      // заглушка прячет ошибку renderVals до прода).
      if (/\/reply$/.test(p)) {
        if (opts.reply409) {
          const e = new Error('409'); e.status = 409;
          e.body = clone(fixtures['/conversations/{id}/reply:409']); throw e;
        }
        return clone(fixtures['/conversations/{id}/reply']);
      }
      if (/\/handoff$/.test(p)) return clone(fixtures['/conversations/{id}/handoff']);
      if (/\/close$/.test(p)) return clone(fixtures['/conversations/{id}/close']);
      return {ok: true};
    },
    patch: async () => ({ok: true}),
    describe: (e) => 'ошибка: ' + (e && e.message ? e.message : e),
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

  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast(){}, drill(){}, trace(){}, go(){}, modal(){}}, mobile:false}, {}); }
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

const listGets = (calls) => calls.get.filter((g) => g.p === '/conversations');
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; }; };

// Проверки не должны обрываться на первом же отсутствующем методе: агенту нужен
// весь список того, чего не хватает, а не первое исключение.
async function open(c, i) {
  if (typeof c.openThread !== 'function') return;
  const row = (c.state.rows || [])[i];
  if (!row) return;
  try { await c.openThread(row); } catch (e) { /* экран обязан пережить это сам */ }
  await new Promise((r) => setTimeout(r, 30));
}

// ── сценарии ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. До загрузки экран уже обязан отдавать все дырки разметки: пустая нитка —
  //    это null, а не отсутствующий ключ, иначе ячейка молча остаётся пустой.
  {
    const {c} = build();
    const v = vals(c);
    check('renderVals() до загрузки не падает', !v.__err);
    check('до загрузки ключ thread присутствует и пуст', 'thread' in v && !v.thread);
  }

  // 2-5. Обычный ход: список непрочитанных, открытие нитки, отметка о прочтении.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await new Promise((r) => setTimeout(r, 30));

    const first = listGets(calls)[0];
    check('первый запрос списка идёт без unread_only (сервер сам даёт непрочитанные)',
          !!first && !('unread_only' in first.q));
    check('unreadTotal взят из ответа', c.state.unreadTotal === LIST.unread_total);

    const v = vals(c);
    check('renderVals отдаёт переключатель unreadToggle с обработчиком',
          !!v.unreadToggle && typeof v.unreadToggle.pick === 'function');

    if (v.unreadToggle && typeof v.unreadToggle.pick === 'function') {
      v.unreadToggle.pick();
      await new Promise((r) => setTimeout(r, 30));
    }
    const second = listGets(calls)[1];
    check('переключатель просит у сервера все диалоги (unread_only=false)',
          !!second && String(second.q.unread_only) === 'false');
  }

  // 6-9. Нитка: порядок событий, отметка о прочтении, счётчик, отсутствие лишних
  //      запросов списка.
  {
    const row = clone(LIST.rows[0]);
    row.unread = true;
    const list = clone(LIST);
    list.rows = [row];

    // События нарочно перевёрнуты: экран обязан упорядочить их сам, а не полагаться
    // на то, в каком порядке их отдала база.
    const thread = clone(THREAD);
    thread.events = clone(THREAD.events).reverse();
    if (thread.events.length < 2) { check('образец нитки содержит хотя бы 2 события', false); }

    const {c, calls} = build({list: list, thread: thread});
    await c.componentDidMount();
    await new Promise((r) => setTimeout(r, 30));
    const listGetsBefore = listGets(calls).length;

    check('openThread — метод экрана', typeof c.openThread === 'function');
    await open(c, 0);

    const got = calls.get.filter((g) => /^\/conversations\/\d+$/.test(g.p));
    check('открытие нитки запрашивает /conversations/{id} ровно один раз', got.length === 1);

    const v = vals(c);
    const ev = (v.thread || {}).events || [];
    check('нитка отдана в renderVals с событиями', ev.length === thread.events.length);
    const times = ev.map((e) => String(e.when || e.created_at || ''));
    check('события идут по возрастанию времени, а не как пришли',
          times.length > 1 && times.every((t, i) => i === 0 || times[i - 1] <= t));
    check('у каждого события видно направление (kind/mine)',
          ev.length > 0 && ev.every((e) => 'kind' in e || 'mine' in e));

    const reads = calls.post.filter((p) => /^\/conversations\/\d+\/read$/.test(p.p));
    check('непрочитанная нитка отмечается прочитанной ровно один раз', reads.length === 1);
    check('строка в списке стала прочитанной без перезапроса списка',
          c.state.rows[0].unread === false && listGets(calls).length === listGetsBefore);
    check('счётчик непрочитанных уменьшился на единицу',
          c.state.unreadTotal === LIST.unread_total - 1);

    // Повторное открытие той же нитки уже ничего не отмечает.
    await open(c, 0);
    check('прочитанная нитка повторно не отмечается',
          calls.post.filter((p) => /\/read$/.test(p.p)).length === 1);

    check('closeThread — метод экрана', typeof c.closeThread === 'function');
    if (typeof c.closeThread === 'function') c.closeThread();
    check('после закрытия нитки в renderVals её нет', !vals(c).thread);

    check('экран не шлёт наружу ничего, кроме отметки о прочтении',
          calls.post.every((p) => /\/read$/.test(p.p)));
  }

  // 10. Сбой нитки не уносит с собой список. Ровно этим болел прошлый заход:
  //     запись адреса стояла до try, и её падение съедало всю таблицу.
  {
    const {c} = build({failThread: true});
    await c.componentDidMount();
    await new Promise((r) => setTimeout(r, 30));
    const rowsBefore = (c.state.rows || []).length;
    await open(c, 0);
    const v = vals(c);
    check('сбой нитки не роняет renderVals', !v.__err);
    check('сбой нитки оставляет список на месте',
          Array.isArray(v.rows) && v.rows.length === rowsBefore);
    check('о сбое нитки сказано отдельно (threadError)', !!v.threadError);
  }

  // 14.8.9/14.8.22. Поле поиска не теряет символы: setQ обязан синхронно
  // перерисовать экран (setState в том же событии input), чтобы renderVals().q
  // равнялся набранному ещё до истечения паузы 350 мс; запрос при этом не
  // уходит. Без синхронной перерисовки React — поле контролируемое
  // (value={{q}}) — откатывает введённую букву к пропу с прошлого рендера.
  {
    const {c, calls} = build();
    await c.componentDidMount();
    await new Promise((r) => setTimeout(r, 30));
    let redraws = 0;
    const origSet = c.setState.bind(c);
    c.setState = (p, cb) => { redraws++; return origSet(p, cb); };
    const before = calls.get.length;
    vals(c).setQ({target: {value: 'Радар'}});
    // Всё ниже — синхронно, до всякой паузы: порядок событий и есть проверка.
    check('поиск: setQ перерисовывает экран синхронно (14.8.9/14.8.22)', redraws > 0);
    check('поиск: renderVals().q равен набранному до истечения паузы',
          vals(c).q === 'Радар');
    check('поиск: во время набора запрос не уходит', calls.get.length === before);
  }

  // ── итог ────────────────────────────────────────────────────────────────────
  // ── 16.5: ответ из нитки, передача/закрытие, focus, чип «написал первым» ──
  const withShell = (c, caps) => {
    const toasts = [], modals = [];
    c.props.api = {toast: (t, col) => toasts.push({t, col}), modal: (m) => modals.push(m),
                   drill() {}, trace() {}, go() {}, capabilities: caps};
    return {toasts, modals};
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  {
    const {c, calls} = build({thread: fixtures['/conversations/{id}:unsolicited']});
    withShell(c, []);
    await c.componentDidMount(); await tick();
    await open(c, 0);
    let v = vals(c);
    check('reply: без capability формы ответа нет, подпись панели на месте',
          v.replyFormShown === false && v.replyFormHidden === true && !!v.panelNote);
    check('reply: без capability нет кнопок передать/закрыть', v.canHandoff === false && v.canClose === false);
    check('reply: чип «написал первым» у source=unsolicited', v.thread && v.thread.unsolicited === true);
    check('reply: колонка «Входящее» в COLUMNS и в строке',
          v.cols.some((x) => /Входящее/.test(x.label)) && typeof v.rows[0].inbound === 'string');
    const sys = (v.thread.events || []).find((e) => e.system);
    check('reply: событие system — серая строка «передан человеку (actor)»',
          !!sys && /передан человеку \(staff@x\)/.test(sys.systemLabel));
  }
  {
    const {c, calls} = build();
    const sh = withShell(c, ['conversation.reply', 'conversation.state']);
    await c.componentDidMount(); await tick();
    await open(c, 0);
    let v = vals(c);
    check('reply: с capability форма показана, кнопка мертва при пустом тексте',
          v.replyFormShown === true && v.replyBtnCursor === 'default');
    v.setReplyText({target: {value: '  Да, поможем  '}});
    v = vals(c);
    check('reply: после ввода кнопка живая', v.replyBtnCursor === 'pointer' && v.replyText.trim() === 'Да, поможем');
    const before = calls.get.length;
    await v.sendReply(); await tick();
    const pf = calls.get.slice(before).filter((g) => /reply-preflight$/.test(g.p));
    check('reply: нажатие — ровно один GET preflight с text', pf.length === 1 && pf[0].q.text === 'Да, поможем');
    check('reply: до подтверждения POST нет', calls.post.filter((x) => /\/reply$/.test(x.p)).length === 0);
    const m = sh.modals[0];
    check('reply: модалка с адресатом и остатком', !!m && m.lines.some((l) => /@user_23/.test(l.text))
          && m.lines.some((l) => /аккаунт #3, остаток 7/.test(l.text)) && m.disabled === false);
    await m.run(); await tick();
    const posts = calls.post.filter((x) => /\/reply$/.test(x.p));
    check('reply: подтверждение — ровно один POST на верный адрес с телом {text}',
          posts.length === 1 && posts[0].p === '/conversations/1/reply' && posts[0].body.text === 'Да, поможем');
    check('reply: тост «Ответ заказан (аккаунт #3)»', sh.toasts.some((t) => /Ответ заказан \(аккаунт #3\)/.test(t.t)));
    check('reply: нитка перечитана, поле очищено',
          calls.get.filter((g) => g.p === '/conversations/1').length >= 2 && vals(c).replyText === '');
    // передать / закрыть
    check('reply: кнопки передать/закрыть при capability', vals(c).canHandoff === true && vals(c).canClose === true);
    await vals(c).handoffThread(); await tick();
    check('reply: handoff — POST и перечитывание списка',
          calls.post.some((x) => x.p === '/conversations/1/handoff') && listGets(calls).length >= 2);
  }
  {
    const {c, calls} = build({blocked: true});
    const sh = withShell(c, ['conversation.reply']);
    await c.componentDidMount(); await tick();
    await open(c, 0);
    let v = vals(c);
    v.setReplyText({target: {value: 'ночью'}});
    await vals(c).sendReply(); await tick();
    const m = sh.modals[0];
    check('reply: gate.allowed=false — подтверждение недоступно, причина показана',
          !!m && m.disabled === true && m.lines.some((l) => /тихие часы/.test(l.text)));
  }
  {
    const {c, calls} = build({reply409: true});
    const sh = withShell(c, ['conversation.reply']);
    await c.componentDidMount(); await tick();
    await open(c, 0);
    vals(c).setReplyText({target: {value: 'ещё раз'}});
    await vals(c).sendReply(); await tick();
    await sh.modals[0].run(); await tick();
    check('reply: 409 — тост с detail', sh.toasts.some((t) => /диалог закрыт/.test(t.t) && t.col === '#DA501C'));
  }
  {
    const {c, calls} = build();
    withShell(c, []);
    c.props.focus = 1;
    await c.componentDidMount(); await tick();
    check('reply: focus=<id> открывает нитку без клика',
          calls.get.some((g) => g.p === '/conversations/1') && !!vals(c).thread);
  }

  for (const [mark, name] of results) console.log(mark + ' ' + name);
  const bad = results.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (results.length - bad) + '/' + results.length + ' проверок прошло');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('стенд упал: ' + e.stack); process.exit(2); });
