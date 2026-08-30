# Atomic Radar Web GUI — карта кода и инструкция по подключению к реальному сервису

Документ для разработчика (в т.ч. для Claude Code): как устроен интерфейс, где лежат данные-заглушки,
что заменить, чтобы админка заработала на настоящей базе, реальных пользователях и настоящих данных.

---

## 1. Что это за файлы

Папка `radar/` — веб-админка Atomic Radar. Все файлы — самодостаточный HTML, открываются в браузере
напрямую, без сборки. Никакого npm, вебпака и роутера здесь нет.

```
radar/
  Atomic Radar.dc.html      ← ОБОЛОЧКА: точка входа, откройте этот файл
  RadarDashboard.dc.html
  RadarFleet.dc.html
  RadarChannels.dc.html
  RadarStream.dc.html
  RadarLeads.dc.html
  RadarDrafts.dc.html
  RadarConversations.dc.html
  RadarProfile.dc.html
  RadarRuns.dc.html
  RadarEvaluations.dc.html
  RadarAttribution.dc.html
  RadarObservability.dc.html
  RadarSafety.dc.html
  RadarAdmin.dc.html
  support.js                ← рантайм компонентов, НЕ редактировать
```

Один файл = один раздел админки. Правка раздела не затрагивает остальные.

### Структура одного файла

Каждый `*.dc.html` состоит из трёх частей:

1. `<x-dc>…</x-dc>` — разметка (шаблон). Значения подставляются через `{{ имя }}`.
   Циклы — `<sc-for list="{{ rows }}" as="r">`, условия — `<sc-if value="{{ flag }}">`.
   В дырках `{{ }}` можно писать ТОЛЬКО имя или путь (`{{ r.name }}`), никаких выражений.
2. `<script data-dc-script>class Component extends DCLogic { … }</script>` — логика.
   Метод `renderVals()` возвращает объект: всё, что в нём, доступно шаблону по имени.
   Здесь же лежат моковые данные (константы `DATA`, `DRAFTS`, `LIMITS` и т.п.).
3. Атрибут `data-props` на теге скрипта — описание входных пропсов компонента.

Стили — только инлайновые (`style="…"`). CSS-классов и внешних стилей нет намеренно.

---

## 2. Как экраны связаны с оболочкой

Оболочка (`Atomic Radar.dc.html`) держит всё общее состояние:

- вход (логин → TOTP), выход;
- текущий маршрут (`state.route`), сайдбар, мобильная нижняя навигация;
- роль пользователя и права доступа (`ACCESS`);
- режим системы `DRY_RUN` / `LIVE` (`state.modeOverride`);
- боковую панель деталей (drill-in) с вкладками Детали / JSON / LLM-трейс;
- модалки подтверждения и тосты.

Экраны монтируются так:

```html
<sc-if value="{{ v.leads }}"><dc-import name="RadarLeads" api="{{ api }}" mobile="{{ false }}" hint-size="100%,400px"></dc-import></sc-if>
```

Каждый экран получает ровно два пропса:

| Проп     | Тип     | Что это |
|----------|---------|---------|
| `api`    | object  | мост к оболочке (см. ниже) |
| `mobile` | boolean | `true` — отрисовать мобильный вариант раздела |

### Контракт `api`

Собирается в `renderVals()` оболочки. Экраны обращаются к нему как `const api = this.props.api || {}`.

```js
api.role                 // 'owner' | 'customer' | 'reviewer' | 'viewer'
api.mode                 // 'DRY_RUN' | 'LIVE'
api.go(route)            // перейти в раздел: 'leads', 'drafts', 'fleet', …
api.toast(text, color)   // всплывающее уведомление
api.drill(payload)       // открыть боковую панель, вкладка «Детали»
api.trace(payload)       // открыть боковую панель, вкладка «LLM-трейс»
api.modal(payload)       // модалка подтверждения
```

**payload для `drill` / `trace`:**

```js
{
  title, subtitle,
  rows: [{k:'Поле', v:'Значение'}],          // таблица деталей
  note: 'предупреждение красным' | null,
  actions: [{label, c:'#156479', run:()=>{}}],// кнопки действий
  log: 'многострочный текст' | undefined,     // блок журнала
  json: '{ … }',                              // вкладка JSON
  llm: {prompt, response, model, temp, tokens, latency, cost, version} // включает вкладку LLM-трейс
}
```

**payload для `modal`:**

```js
{
  kind: 'live' | 'dry' | 'kill' | undefined,  // спец-режимы, обрабатываются в confirmModal()
  title,
  lines: [{text:'что произойдёт'}],
  word: 'LIVE',                               // требовать ввод слова (необязательно)
  confirm: 'Подпись кнопки', btnBg: '#DA501C',
  done: 'Текст тоста после подтверждения'
}
```

Подтверждение обрабатывается в оболочке, метод `confirmModal()`. **Именно туда надо повесить
реальные вызовы API** для необратимых действий (переключение LIVE, kill switch, отклонения и т.п.).

---

## 3. Где лежат данные-заглушки

Все моки — константы в классе `Component` соответствующего файла. Формат мока = формат,
который экран ожидает получить с бэкенда. Заменяя мок на fetch, сохраняйте те же имена полей —
шаблон править не придётся.

| Файл | Константа | Что содержит |
|------|-----------|--------------|
| `RadarDashboard` | `FLEET`, `SERVICES`, + `tiles/queues/errors/funnel/chart` в `renderVals()` | плитки метрик, статус флота, очереди, ошибки за 24ч, график, воронка |
| `RadarFleet` | `DATA` | аккаунты: статус, прокси, geo, TZ, лимиты, аптайм |
| `RadarChannels` | `DATA` | каналы: участники, сообщ/сут, префильтр, лиды, лид/1000 |
| `RadarStream` | `DATA` | сырые сообщения + результат каскада L0–L3 (массив `c`) |
| `RadarLeads` | `DATA` | лиды: автор, канал, боль, скор, статус |
| `RadarDrafts` | `DRAFTS`, `REASONS` | очередь черновиков: ветка, разбор скора, 3 варианта ответа, линтер, самокритика; причины отклонения |
| `RadarConversations` | `DATA` | диалоги: собеседник, аккаунт, состояние, ожидание |
| `RadarProfile` | `PAINS` | таксономия болей; описание бизнеса — текстом в шаблоне |
| `RadarRuns` | `DATA` | прогоны: тип, статус, прогресс, ETA, GPU-часы |
| `RadarEvaluations` | `DATA` | метрики версий промптов (precision/recall/F1) |
| `RadarAttribution` | `DATA`, `UNIT` | реф-токены и юнит-экономика по каналам |
| `RadarObservability` | `DATA` | LLM-трейсы; железо и логи — в шаблоне |
| `RadarSafety` | `LIMITS`, `BLOCKLISTS`, `GUARD` | лимиты/пороги, блок-листы, журнал срабатываний гардрейлов |
| `RadarAdmin` | `USERS`, `SQL`, `AUDIT` | пользователи, результат SQL-консоли, аудит |
| `Atomic Radar` (оболочка) | `ACCESS`, `NAV`, `USERS`, `TITLES`, `ALERTS` | права, меню, профили пользователей, алерты в шапке |

---

## 4. Порядок подключения к реальному сервису

### Шаг 0. Определиться с бэкендом

Ожидается REST поверх существующего сервиса Radar (FastAPI/Flask/любой), JSON, cookie-сессия
или Bearer-токен. Базовый URL вынести в одно место — см. шаг 2.

### Шаг 1. Аутентификация (оболочка)

Сейчас вход бутафорский: `doLogin()` просто проверяет непустые поля, `setTotp()` через 250 мс
ставит `authed:true`. Заменить в `Atomic Radar.dc.html`, метод `renderVals()`:

```js
doLogin: async () => {
  const r = await fetch(API + '/auth/login', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username: S.login.u, password: S.login.p})
  });
  if(!r.ok){ this.setState({loginError:true}); return; }
  this.setState({step:'totp', loginError:false});
},
setTotp: async (e) => {
  const val = e.target.value.replace(/[^0-9]/g,'').slice(0,6);
  this.setState({totp: val});
  if(val.length < 6) return;
  const r = await fetch(API + '/auth/totp', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({code: val})
  });
  if(!r.ok){ this.setState({loginError:true, totp:''}); return; }
  const me = await r.json();           // {name, initials, email, role}
  this.setState({authed:true, me});
},
```

И `logout: () => fetch(API + '/auth/logout', {method:'POST', credentials:'include'}).then(...)`.

Роль пользователя приходит с сервера. Селектор ролей в меню профиля (`roleOptions`) — **инструмент
прототипа**, в бою его надо убрать или оставить только для owner как «просмотр глазами роли».
Права в `ACCESS` в оболочке — только для скрытия пунктов меню; **дублируйте проверку на сервере**.

### Шаг 2. Единая точка доступа к API

Создать `radar/radar-api.js` (обычный ES-модуль) и импортировать его динамически из логики экранов:

```js
export const API = '/api/v1';
export async function get(path, params){
  const q = params ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(API + path + q, {credentials:'include'});
  if(!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}
export async function post(path, body){
  const r = await fetch(API + path, {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}
```

### Шаг 3. Перевести экран на живые данные

Шаблон трогать не нужно — меняется только логика. Схема одинаковая для всех экранов:

```js
class Component extends DCLogic {
  state = { rows: [], loading: true, error: null };

  async componentDidMount(){
    try {
      const { get } = await import('./radar-api.js');
      const rows = await get('/leads', {limit: 50});
      this.setState({rows, loading: false});
    } catch (e) {
      this.setState({error: String(e), loading: false});
    }
  }

  renderVals(){
    const api = this.props.api || {};
    return {
      desktop: !this.props.mobile, isMobile: !!this.props.mobile,
      cols: ['Автор','Канал','Боль','Скор','Статус'],
      rows: this.state.rows.map(l => ({ ...l, open: () => api.drill && api.drill({ … }) }))
    };
  }
}
```

Порядок миграции по ценности: **Leads → Drafts → Stream → Fleet → Conversations → остальные.**

### Шаг 4. Действия, меняющие состояние

Все кнопки сейчас зовут `api.toast(...)` — заглушка. Каждое реальное действие оформляется как
`post(...)` + обновление состояния + тост. Необратимые — обязательно через `api.modal(...)`
(см. `confirmModal()` в оболочке).

Минимальный список действий:

| Раздел | Действие | Метод |
|--------|----------|-------|
| Drafts | одобрить / править+одобрить / отклонить с причиной | `POST /drafts/{id}/approve`, `/edit`, `/reject` |
| Leads | отклонить лид, массовое отклонение | `POST /leads/{id}/reject`, `POST /leads/bulk-reject` |
| Fleet | пауза, возобновление, смена прокси, `get_me()` | `POST /accounts/{id}/{action}` |
| Channels | вкл/выкл ингест, бэкфилл, пометить мусорным | `POST /channels/{id}/…` |
| Conversations | отправить / править / не отвечать / передать заказчику | `POST /conversations/{id}/…` |
| Runs | запустить, повторить, отменить | `POST /runs`, `POST /runs/{id}/retry|cancel` |
| Safety | DRY_RUN ⇄ LIVE, kill switch, правка лимитов | `POST /system/mode`, `POST /system/kill`, `PATCH /limits/{key}` |
| Profile | сохранить версию профиля, прогон плейграунда | `POST /profile/versions`, `POST /profile/playground` |
| Admin | сброс TOTP, SQL-запрос (read-only) | `POST /users/{id}/reset-totp`, `POST /sql/query` |

**Режим системы — критично.** Флаг `DRY_RUN` должен жить в базе и проверяться на сервере перед
каждой отправкой. Интерфейс отражает его, но не является источником правды. Kill switch —
отдельная ручка, останавливающая воркеры менее чем за 5 секунд.

### Шаг 5. Живые обновления

На Dashboard, Stream и Runs подписи «● живое обновление» пока декоративные. Достаточно опроса:

```js
componentDidMount(){ this.load(); this.timer = setInterval(()=>this.load(), 15000); }
componentWillUnmount(){ clearInterval(this.timer); }
```

Либо SSE `/events` — тогда оболочка может пробрасывать события в экраны через `api`.

---

## 5. Данные для первого теста

### Тестовые пользователи

| Имя | Email | Роль | Что видит |
|-----|-------|------|-----------|
| Владелец | owner@atomic-automation.net | `owner` | всё, включая Fleet, Runs, Observability, Admin |
| Заказчик | customer@atomic-automation.net | `customer` | всё кроме Fleet, Runs, Observability, Admin |

Обоим включить TOTP. Пароли — только через хеш (argon2/bcrypt), в интерфейсе не хранятся.
Роли `reviewer` и `viewer` заложены в `ACCESS` и понадобятся позже.

Матрица доступа — константа `ACCESS` в оболочке; продублировать её на сервере:

```
dashboard      owner customer reviewer viewer
fleet          owner
channels       owner customer reviewer
stream         owner customer reviewer
leads          owner customer reviewer
drafts         owner customer reviewer
conversations  owner customer reviewer
profile        owner customer reviewer
runs           owner
evals          owner customer reviewer
attribution    owner customer viewer
observability  owner
safety         owner customer
admin          owner
```

### Минимальный набор сущностей для первого прогона

Чтобы интерфейс ожил, достаточно наполнить эти таблицы (имена полей — как в моках):

- `accounts` — 5 записей: `acct, status(active|warmup|sleeping|banned), proxy, country, tz, limits_day, limits_hour, last_action_at, watcher_uptime`
- `channels` — 3–5 записей: `name, topic, members, msgs_per_day, prefilter_rate, leads, leads_per_1000, ingest_enabled`
- `messages` — сырые сообщения: `channel_id, author, username, text, ts, cascade(l0,l1,l2,l3)`
- `leads` — `message_id, author, username, channel, pain, score, score_breakdown(jsonb), status`
- `drafts` — `lead_id, variants(jsonb: text, spam_score, prompt_version, lint_ok, critic), state`
- `conversations` — `lead_id, account_id, state, last_message, waiting_since`
- `runs` — `name, type, params(jsonb), status, progress, gpu_hours, error`
- `limits` — пары ключ-значение из раздела Safety (см. `LIMITS` в `RadarSafety.dc.html`)
- `audit_log` — `ts, user, action, ip`

Сидировать проще всего прямо из моков: значения в файлах — правдоподобные и согласованные между
экранами (те же аккаунты, каналы и авторы встречаются в Dashboard, Fleet, Stream, Leads, Drafts).

**Порядок первого теста:** сид → вход обоими пользователями → Dashboard показывает реальные счётчики →
Stream отдаёт настоящие сообщения с каскадом → Leads показывает найденные лиды → Drafts даёт
одобрить/отклонить и записывает решение в базу. Всё это — строго в `DRY_RUN`.

---

## 6. Чего делать не надо

- Не переписывать разметку ради подключения данных: моки уже имеют форму ответа API.
- Не заводить CSS-классы и внешние стили — вёрстка держится на инлайновых стилях.
- Не писать выражения в `{{ }}`: любые вычисления делаются в `renderVals()`.
- Не редактировать `support.js`.
- Не полагаться на клиентские проверки прав и на клиентский флаг `DRY_RUN` — оба обязаны
  проверяться на сервере.
