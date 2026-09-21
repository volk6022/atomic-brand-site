// Markdown → безопасный HTML для карточки ответа («Пачки и ревью»).
//
// Библиотеки лежат локально, без CDN (SPEC §3): vendor/marked.esm.js
// (marked 15, ESM) и vendor/purify.es.js (DOMPurify 3.2.6, ESM). Пути — от
// каталога radar/, то есть ../vendor/…. Обе грузятся динамическим import()
// внутри функции и ровно один раз (кэш — модульная переменная с промисом):
// пока в карточке не показался ни один Markdown-ответ, за их загрузку экран
// не платит вовсе.
//
// renderMarkdown(text) → строка HTML:
//   marked.parse(text, {gfm:true, breaks:false}) — GFM-разметка, переводы
//   строк внутри абзаца не превращаются в <br>;
//   DOMPurify.sanitize(html, {USE_PROFILES:{html:true}}) — белый список HTML,
//   скрипты, on*-обработчики и javascript:-URL не проходят.
// Ссылки открываются в новой вкладке: hook afterSanitizeAttributes ставит
// target="_blank" rel="noopener noreferrer" (атрибуты, проставленные в этом
// хуке, DOMPurify уже не срезает — так рекомендует документация DOMPurify).

let libsP = null;

function libs() {
  if (!libsP) {
    libsP = (async () => {
      const m = await import('../vendor/marked.esm.js');
      const p = await import('../vendor/purify.es.js');
      const DOMPurify = p.default;
      // Хук ставится один раз на инстанс DOMPurify — при повторных вызовах
      // renderMarkdown список хуков не растёт.
      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node && node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
      return {marked: m.marked, DOMPurify};
    })();
  }
  return libsP;
}

export async function renderMarkdown(text) {
  const {marked, DOMPurify} = await libs();
  const html = marked.parse(String(text), {gfm: true, breaks: false});
  return DOMPurify.sanitize(html, {USE_PROFILES: {html: true}});
}
