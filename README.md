# Combat Map — новости главного меню

Новости для панели в главном меню игры. Редактируются через сайт, публикуются автоматически,
**без пересборки и релиза игры**.

| Что | Адрес |
|---|---|
| Редактор (Sveltia CMS) | https://handwriter.github.io/combatmap-news/admin/ |
| Предпросмотр карточек | https://handwriter.github.io/combatmap-news/ |
| Фид для игроков | https://handwriter.github.io/combatmap-news/v1/news.json |
| Фид с черновиками (dev-сборки) | https://handwriter.github.io/combatmap-news/v1/news.preview.json |

## Как опубликовать новость

1. Открыть редактор → **Sign In with Token** → вставить свой GitHub-токен (см. ниже).
2. **News → New News item**. Обязательны только **Title (en)** и **Published at**; картинка,
   текст и кнопка — по желанию (пустые блоки в карточке не показываются). Переводы ru / tr / fr / ar
   — на вкладках языков; чего нет, игроки увидят на английском.
3. Оставить **Draft** включённым и сохранить → новость появится в `news.preview.json`
   (dev-сборки игры и страница предпросмотра в режиме *Preview*).
4. Выключить **Draft** и сохранить → через 1–2 минуты новость в `news.json`, игроки увидят её
   при следующем входе в главное меню (CDN GitHub Pages кэширует до 10 минут).

Показ по расписанию — поля **Show from / Show until** (UTC): новость можно выложить заранее,
игра сама покажет и скроет её. Ограничение по версии игры — **Min / Max game version** (`0.107`).
Порядок: **Priority** по убыванию, при равенстве — новее выше; в меню максимум 4 новости.

Каждое сохранение — коммит в `main`. Workflow **Publish news** проверяет все записи; если что-то
не так (нет английского заголовка, ссылка кнопки не https, неверные даты),
сборка падает, GitHub присылает письмо, а игроки продолжают видеть прошлую версию фида.

## Доступ для редактора

1. Владелец репо: **Settings → Collaborators → Add people** (роль Write).
2. Редактор: GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**:
   - Repository access: *Only select repositories* → `handwriter/combatmap-news`;
   - Permissions → Repository → **Contents: Read and write**;
   - срок действия — по вкусу (после истечения выпустить новый).
3. Токен вводится в редакторе один раз и хранится только в браузере.

## Устройство

```
admin/            редактор: index.html (Sveltia CMS) + config.yml (поля формы)
content/news/     одна новость = один JSON (Sveltia i18n single_file: { en: {...}, ru: {...} })
content/media/    загруженные картинки-оригиналы
site/index.html   страница предпросмотра
schema/           news-feed.schema.json — контракт фида с игрой (NewsFeedDto.cs)
scripts/build.mjs валидация + сборка dist/ (картинки → JPEG 640×360, имя = sha1)
```

Локально (Node 20+):

```bash
npm ci
npm test
npm run build   # dist/v1/news.json, dist/v1/news.preview.json, dist/v1/img/*.jpg
```

Совместимость: фид лежит под `/v1/`. Добавлять новые необязательные поля можно;
ломающие изменения — только в новый `/v2/`, чтобы старые версии игры продолжали работать.
