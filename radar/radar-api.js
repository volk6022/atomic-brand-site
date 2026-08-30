// Единая точка доступа к Radar API.
//
// Статика и API живут на одном origin (radar.atomic-automation.net), поэтому путь
// относительный, а сессия ездит обычной cookie — `credentials:'same-origin'` нужен,
// потому что fetch по умолчанию их не шлёт.
//
// Экраны импортируют этот модуль динамически из своей логики:
//     const { get } = await import('./radar-api.js');
//     const data = await get('/leads', { limit: 50 });

export const API = '/api/v1';

class ApiError extends Error {
  constructor(status, path, body) {
    super(`${path} → ${status}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

async function parse(response, path) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!response.ok) throw new ApiError(response.status, path, body);
  return body;
}

export async function get(path, params) {
  const q = params ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(API + path + q, { credentials: 'same-origin' });
  return parse(r, path);
}

export async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return parse(r, path);
}

export async function patch(path, body) {
  const r = await fetch(API + path, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return parse(r, path);
}

// Поток серверных событий. Стоит рядом с get/post не по родству, а по адресу:
// базовый путь у него тот же, и разъехаться этим двум местам нельзя.
//
// Отличие от остальных — соединение вместо запроса: оно живёт, пока открыта
// вкладка, и закрывается вручную. Открывать его до входа бессмысленно — без куки
// сервер отвечает обычным 401, а EventSource на отказ реагирует бесконечными
// попытками переподключиться.
//
// `withCredentials` здесь по той же причине, что и `credentials:'same-origin'`
// выше: сессия ездит обычной cookie.
export function stream() {
  return new EventSource(API + '/events', { withCredentials: true });
}

// 401 означает, что сессия кончилась, — в этом случае экрану нечего показывать,
// и правильная реакция одна: вернуть пользователя на вход, а не рисовать пустую
// таблицу, по которой не понять, что произошло.
export function isUnauthorized(err) {
  return err instanceof ApiError && err.status === 401;
}

export function isForbidden(err) {
  return err instanceof ApiError && err.status === 403;
}

// Человеческий текст ошибки для тоста. Сообщение сервера показываем как есть,
// когда оно есть: «leads → 500» пользователю ничего не объясняет.
export function describe(err) {
  if (!(err instanceof ApiError)) return String(err && err.message || err);
  if (err.status === 401) return 'Сессия истекла, войдите заново';
  if (err.status === 403) return 'Нет доступа к этому разделу';
  const detail = err.body && (err.body.detail || err.body.message);
  return detail ? detailText(detail, err.status) : `Ошибка ${err.status}`;
}

// FastAPI отдаёт `detail` двумя разными способами, и разница видна только человеку.
// Наши ручки кладут туда строку, а вот встроенная проверка pydantic — список записей
// вида `{loc, msg, type}`. `String()` над таким списком печатает «[object Object]»,
// то есть ровно на том отказе, ради которого требование «показать текст из detail»
// и написано, пользователь получает мусор вместо причины.
//
// Поле `loc` намеренно не показывается: там путь внутри тела запроса
// (`body.suggested_text`), понятный тому, кто писал экран, а не тому, кто его открыл.
function detailText(detail, status) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const lines = detail.map(d => (d && typeof d === 'object' && d.msg)
      ? String(d.msg) : String(d)).filter(Boolean);
    if (lines.length) return lines.join('; ');
  }
  if (detail && typeof detail === 'object' && detail.msg) return String(detail.msg);
  return `Ошибка ${status}`;
}

// Выгрузка таблицы в CSV. Делается на клиенте из уже загруженных строк — ручки
// экспорта на сервере нет, и кнопка, которая обещает «экспорт запущен, придёт
// уведомление», а на деле не делает ничего, хуже отсутствующей кнопки.
//
// Разделитель — точка с запятой, а BOM ставится намеренно: Excel с русской локалью
// иначе открывает запятую-CSV одной колонкой и ломает кириллицу в UTF-8 без BOM.
export function downloadCsv(filename, columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => esc(c.get(row))).join(';'));

  const blob = new Blob(['﻿' + lines.join('\r\n')],
                        { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return rows.length;
}

export { ApiError };
