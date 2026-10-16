#!/usr/bin/env python3
"""PUBLISH.md для недели «Уютного дома»: таблица и готовый промпт для Claude in Chrome.

python3 publish_md.py <папка недели> [--skip-posts Пн-1,Пн-2] [--skip-clips ...]

Папка недели (= weeks/<дата понедельника>/ в репозитории) содержит plan.json:
  [{"code":"Пн-1","id":"mon-1","date":"2026-10-19","post":"09:00","clip":"11:00",
    "music":"уютный джаз","topic":"Уютная спальня","mechanic":"подписка"}, ...]
и файлы по id: <id>.jpg, txt/<id>.txt, clip_<id>.mp4, desc/<id>.txt.
Проверяет, что все файлы на месте, и пишет PUBLISH.md. Код возврата 1, если чего-то не хватает.
"""
import argparse
import json
import os
import sys

MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
REPO = 'Aleks-git-sites-202020/uyutny-dom'


def ru_date(d):
    y, m, dd = d.split('-')
    return f'{int(dd)} {MON[int(m) - 1]}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('week')
    ap.add_argument('--skip-posts', default='')
    ap.add_argument('--skip-clips', default='')
    a = ap.parse_args()
    week = a.week.rstrip('/')
    rel = 'weeks/' + os.path.basename(week)
    plan = json.load(open(os.path.join(week, 'plan.json'), encoding='utf-8'))
    skip_p = {c for c in a.skip_posts.split(',') if c}
    skip_c = {c for c in a.skip_clips.split(',') if c}

    missing = []
    for it in plan:
        i = it['id']
        for f in (f'{i}.jpg', f'txt/{i}.txt', f'clip_{i}.mp4', f'desc/{i}.txt'):
            if not os.path.exists(os.path.join(week, f)):
                missing.append(f)
    if missing:
        print('НЕ ХВАТАЕТ ФАЙЛОВ: ' + ', '.join(missing))
        sys.exit(1)

    first = ru_date(plan[0]['date'])
    last = ru_date(plan[-1]['date'])
    rows = []
    for it in plan:
        p = '(уже стоит)' if it['code'] in skip_p else it['post']
        c = '(уже стоит)' if it['code'] in skip_c else it['clip']
        rows.append(f"| {it['code']} | {it['id']} | {ru_date(it['date'])} | {p} | {c} | {it['music']} |")
    n_posts = len(plan) - len(skip_p)
    n_clips = len(plan) - len(skip_c)
    skip_line = ''
    if skip_p or skip_c:
        parts = []
        if skip_p:
            parts.append('посты ' + ', '.join(sorted(skip_p)))
        if skip_c:
            parts.append('клипы ' + ', '.join(sorted(skip_c)))
        skip_line = f"\nУже стоят в отложенных: {'; '.join(parts)} — их НЕ ставь.\n"

    topics = '\n'.join(
        f"| {it['code']} | {ru_date(it['date'])} {it['post']} / {it['clip']} | {it.get('topic', '')} | {it.get('mechanic', '')} |"
        for it in plan)

    prompt = f"""Уютный дом — поставь пакет недели {first} – {last} в отложенные VK-сообщества «Уютный дом» (https://vk.com/creativsss, id −55440514). Пакет одобрен мной полностью.

Файлы — в репозитории {REPO}, папка {rel} (локальная копия: git clone или Download ZIP):
- картинка поста: {rel}/<id>.jpg, текст поста: {rel}/txt/<id>.txt (вставлять как есть, с пустыми строками между абзацами);
- клип: {rel}/clip_<id>.mp4, описание клипа: {rel}/desc/<id>.txt.
{skip_line}
Перед началом открой отложенные посты и клипы сообщества и сверь с таблицей, чтобы ничего не задублировать.

Расписание (время московское):
| Код | id | Дата | Пост | Клип | Музыка клипа (поиск в VK) |
|---|---|---|---|---|---|
{chr(10).join(rows)}

Посты ({n_posts}): «Создать пост» → если VK предложит открыть черновик — «Начать заново» → загрузить одну картинку <id>.jpg (проверь, что фото ровно одно) → вставить текст из txt/<id>.txt → «Далее» → «Запланировать» → дата и время из таблицы → проверь дату на кнопке → «Добавить в очередь».

Клипы ({n_clips}): «Опубликовать клип» → загрузить clip_<id>.mp4 → дождаться «Клип загружен и обработан» → описание из desc/<id>.txt → «Указать музыку» → поиск по запросу из таблицы → «Прикрепить» на первом доступном треке (пропускай «Звук клипа недоступен») → «Когда опубликовать» → дата и время из таблицы → «Запланировать публикацию». «Реклама от автора» не включать.

Правила:
- НИКОГДА не нажимай «Опубликовать» / «Опубликовать сейчас» (публикация сразу) — только планирование в отложенные.
- Не чаще одной загрузки (пост или клип) в 5 минут. Сначала все посты, потом клипы.
- Если VK покажет капчу, «Проверяем, что вы не робот», сообщение о взломе/блокировке или «Не удалось загрузить фото» — сразу остановись и напиши мне, ничего не нажимай.
- Если пост или клип не встал с 2 попыток — пропусти, запиши и иди дальше.
- В конце открой отложенные посты и клипы и дай отчёт таблицей: код → пост (время, статус) → клип (время, трек, статус)."""

    md = f"""# Публикация недели {first} – {last}

Готовый пакет «Уютного дома». В VK его ставит пользователь сам — через Claude in Chrome, в своём браузере.

1. Скачайте репозиторий: https://github.com/{REPO} → Code → Download ZIP (или `git clone`), распакуйте.
2. Откройте VK в Chrome (вы должны быть залогинены), откройте панель Claude in Chrome.
3. Вставьте промпт ниже. Если расширение не сможет само выбрать файл — выберите его в окне загрузки по имени из таблицы.

## Темы недели

| Код | Пост / клип | Тема | Механика |
|---|---|---|---|
{topics}

## Промпт для Claude in Chrome

```
{prompt}
```
"""
    open(os.path.join(week, 'PUBLISH.md'), 'w', encoding='utf-8').write(md)
    print(f'OK {os.path.join(week, "PUBLISH.md")}: постов {n_posts}, клипов {n_clips}')


if __name__ == '__main__':
    main()
