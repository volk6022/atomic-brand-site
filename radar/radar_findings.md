# Hardcoded Data Values in RadarDrafts.dc.html

## Summary
Found **19** hardcoded data values displayed to users that are not sourced from API data.

## Complete List

### 1. Rejection Reason Labels (lines 221-223)
These are shown when a message fails quality checks:

| Line | Value | Explanation |
|------|-------|-------------|
| 221 | `'Не та боль'` | Rejection reason label shown to user |
| 221 | `'Не тот человек'` | Rejection reason label shown to user |
| 221 | `'Звучит как реклама'` | Rejection reason label shown to user |
| 222 | `'Слишком длинно'` | Rejection reason label shown to user |
| 222 | `'Фактическая ошибка'` | Rejection reason label shown to user |
| 223 | `'Дублирует отправленное'` | Rejection reason label shown to user |
| 223 | `'Ссылка в первом сообщении'` | Rejection reason label shown to user |
| 223 | `'Другое'` | Rejection reason label shown to user |

### 2. Verdict Messages (line 361)
Status messages shown when deciding whether to allow sending:

| Line | Value | Explanation |
|------|-------|-------------|
| 361 | `' · отправка разрешена'` | Success message shown to user |
| 361 | `' · не отправлено (' + (send.reasons || []).join('; ') + ')'` | Error message with reasons shown to user |

### 3. Default Prompt Text (line 453)
Default instruction text shown in the LLM trace panel:

| Line | Value | Explanation |
|------|-------|-------------|
| 453 | `'Ты пишешь короткое нативное сообщение человеку, который в открытом чате проговорил проблему. Не рекламируй, не обещай, не давай ссылок в первом сообщении.'` | Default prompt text displayed in trace |

### 4. Spam Level Labels (line 464)
Labels for spam risk levels shown to users:

| Line | Value | Explanation |
|------|-------|-------------|
| 464 | `'низкий'` | Spam level label shown to user |
| 464 | `'средний'` | Spam level label shown to user |
| 464 | `'высокий'` | Spam level label shown to user |

### 5. Hotkey Descriptions (lines 508-512)
Keyboard shortcut help text shown to users:

| Line | Value | Explanation |
|------|-------|-------------|
| 508 | `'следующий / предыдущий лид'` | Hotkey description shown to user |
| 509 | `'переключить вариант'` | Hotkey description shown to user |
| 509 | `'одобрить активный вариант'` | Hotkey description shown to user |
| 509 | `'редактировать вариант'` | Hotkey description shown to user |
| 510 | `'выбор причины отклонения'` | Hotkey description shown to user |
| 510 | `'1…9 после R'` | Hotkey description shown to user |
| 510 | `'типизированная причина'` | Hotkey description shown to user |
| 511 | `'открыть ветку в Telegram'` | Hotkey description shown to user |
| 511 | `'LLM-трейс'` | Hotkey description shown to user |
| 512 | `'закрыть панель'` | Hotkey description shown to user |
| 512 | `'командная палитра'` | Hotkey description shown to user |

### 6. Lint Rule Labels (lines 532-534)
Quality check descriptions shown in the UI:

| Line | Value | Explanation |
|------|-------|-------------|
| 532 | `'нет ссылок в первом сообщении'` | Lint rule label shown in UI |
| 533 | `'без капса'` | Lint rule label shown in UI |
| 534 | `'без эмодзи-спама'` | Lint rule label shown in UI |

### 7. Placeholder Values for Missing Data (line 473)
Default values shown when data fails to load:

| Line | Value | Explanation |
|------|-------|-------------|
| 473 | `author:'—'` | Placeholder displayed when author data missing |
| 473 | `username:''` | Empty string placeholder displayed |
| 473 | `channel:'—'` | Placeholder displayed when channel data missing |
| 473 | `pain:'—'` | Placeholder displayed when pain point data missing |
| 473 | `score:'—'` | Placeholder displayed when score data missing |

## Verification Notes

- All values were verified to be **literal strings** in the HTML file
- None of these values come from API responses
- All values are **user-facing** (shown in the UI)
- Values include: labels, messages, instructions, and placeholder displays

## Exclusions (Not Data Values)

The following were correctly excluded as per guidelines:
- Style values (colors, CSS properties)
- Column headers and static labels
- Button captions and hint attributes
- UI element IDs and names
- Developer/debugging strings
