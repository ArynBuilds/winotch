# The local API

Any program on your computer can put itself on the island: a pill, a row in **Settings → Apps**, notifications in the bell with buttons, and a list shown when the app is opened. Claude Code uses the same API through winotch's MCP tools.

[`examples/hello-app.mjs`](../examples/hello-app.mjs) is a complete app in one file, with no dependencies. Start winotch, then run `node examples/hello-app.mjs`.

- [Connecting](#connecting)
- [Apps, status, notifications](#apps-status-notifications)
- [Lists](#lists)
- [Presses and details: the callback](#presses-and-details-the-callback)
- [Today: to-dos and notes](#today-to-dos-and-notes)
- [Mail](#mail)
- [Claude Code sessions](#claude-code-sessions)
- [Limits](#limits)

## Connecting

winotch serves plain HTTP on `127.0.0.1` only, on port 47830 (another one when that is taken). At every start it writes where it is and a fresh token to `api.json`, in a folder only your Windows user can read:

| | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\winotch\api.json` |
| Linux | `$XDG_DATA_HOME/winotch/api.json` (`~/.local/share/winotch/api.json`) |

```json
{ "url": "http://127.0.0.1:47830", "token": "…" }
```

Read it each time you start, since the token changes. Every call except `GET /v1/health` sends `Authorization: Bearer <token>`. Bodies are JSON, and so are answers; an error is `{ "error": "…" }` with a 4xx status that says which field was wrong.

```powershell
$api = Get-Content "$env:LOCALAPPDATA\winotch\api.json" | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($api.token)" }
Invoke-RestMethod "$($api.url)/v1/apps" -Headers $h
```

## Apps, status, notifications

| Call | Body or query | Does |
| --- | --- | --- |
| `GET /v1/health` | | `{ ok, name: "winotch" }`, no token needed |
| `POST /v1/apps` | `id` (1 to 32 of `a-z 0-9 -`), `name` (≤ 40), `sign` (1 to 3 of `-` and `.`), `icon` (a `data:image/png;base64,…` or `data:image/svg+xml,…` URL, ≤ 32 KB), `callback` (`http://` on `127.0.0.1` or `localhost`), `status` (≤ 120) | Registers the app, or updates it: what a second call leaves out is kept. It gets a pill and a row in Settings → Apps. The user's on/off and quiet switches are theirs, never reset by the app |
| `GET /v1/apps` | | Every app, built-ins included |
| `POST /v1/status` | `app`, `status` | What its pill says now ("3 drafts") |
| `POST /v1/notify` | `app`, `title` (≤ 200), `body` (≤ 2000), `url` (http or https, opened on click), `importance` (`low`, `normal`, `high`), `actions` (up to 3 of `{ id, label }`, label ≤ 24), `item` (≤ 64, the id of a list item it is about) | A notification. `high` opens the island, `normal` peeks it, `low` waits behind the bell. A quiet app's always waits. With `item`, a click opens the app on that item instead of `url`. Answers `{ id }` |
| `GET /v1/notifications` | `app`, `unread=1`, `limit` (≤ 300) | The feed, newest first. `acted` says which action was pressed |
| `POST /v1/read` | `id`, or `app`, or nothing | Marks one, one app's, or all read |

A waiting Claude Code approval or question always wins: while one waits, no notification takes the island from it.

The ids of the built-in apps (`github`, `stripe`, `notion`, `spotify`, `gmail`, `today`) are reserved: no other app can register or post as them (403). `claude` is the app Claude Code's MCP tools post as; its notifications show under Claude Code's pill.

## Lists

An app's list is what the island shows when you open it (click its card): an inbox, open drafts, a queue. It is data and never opens the island.

`POST /v1/items` replaces the app's whole list:

```json
{
  "app": "hello",
  "status": "2 open",
  "views": [{ "id": "all", "label": "All" }, { "id": "mine", "label": "Mine" }],
  "sections": [
    {
      "title": "Today",
      "items": [
        {
          "id": "a1",
          "title": "Review the launch post",
          "subtitle": "Draft · 2 min ago",
          "time": 1761300000000,
          "unread": true,
          "url": "https://example.com/drafts/a1",
          "actions": [{ "id": "posted", "label": "Posted" }, { "id": "drop", "label": "Drop" }],
          "detail": true,
          "views": ["all", "mine"]
        }
      ]
    }
  ]
}
```

- `sections`: up to 5, each up to 50 items. No sections clears the list.
- An item: `id` (≤ 64, unique in the list), `title` (≤ 200), `subtitle` (≤ 300), `time` (ms), `unread`, `url` (http, https or mailto), `actions` (up to 3), `detail` (a click opens its details, below), `views` (the views it is in; absent: all of them).
- `views`: up to 6 of `{ id (≤ 24), label (≤ 20) }`, shown as filters in the expanded view's left column. An item may only name views the list declares.

## Presses and details: the callback

When the user presses a button, winotch posts to the app's `callback`:

| Pressed | Body |
| --- | --- |
| A notification's action | `{ app, notification, action, title }` |
| A list item's action | `{ type: "item", app, item, action, title }` |
| A click on an item with `detail` | `{ type: "detail", app, item }` |

The app does the work. For `detail`, it answers with the item's details as JSON (≤ 256 KB):

```json
{
  "title": "Review the launch post",
  "meta": ["From Ada", "2026-10-24 09:05"],
  "body": "Plain text, line breaks kept.",
  "attachments": ["post.png"],
  "url": "https://example.com/drafts/a1",
  "actions": [{ "id": "posted", "label": "Posted" }]
}
```

`meta`: up to 8 lines of ≤ 300; `body`: ≤ 20 000 characters; `attachments`: up to 20 names. Its actions are pressed as the item's own. No answer within 20 s, or one past a limit, shows one line saying so in the pane.

## Today: to-dos and notes

| Call | Takes | Gives |
| --- | --- | --- |
| `GET /v1/today/todos` | `from`, `to` (YYYY-MM-DD, both included), `done` (`1` or `0`), `overdue=1` (also what is open from before `from`), `undated=1` (also someday's); no range: all | `{ today, weekday, now, todos }`, by day, someday last |
| `POST /v1/today/todos` | `title`, `note`, `date`, `time` (HH:MM, 24 h; needs a date), `done` | The to-do. With a date and a time, the island reminds you then |
| `GET /v1/today/todos/{id}` | | The to-do |
| `PATCH /v1/today/todos/{id}` | any of `title`, `note`, `date`, `time`, `done`; `null` clears | The to-do |
| `DELETE /v1/today/todos/{id}` | | `{ ok, deleted }` |
| `GET /v1/today/notes` | `q` (every word, any case) | `{ notes: [{ id, title, updated, created, chars, preview, snippet? }] }`, newest first |
| `POST /v1/today/notes` | `title` (or the body's first line), `body` | The note |
| `GET /v1/today/notes/{id}` | | The note, whole |
| `PATCH /v1/today/notes/{id}` | `title`, `body` (replace), `append` (a new line at the end) | The note |
| `DELETE /v1/today/notes/{id}` | | `{ ok, deleted }` |

Days and times are the computer's own clock, never converted. At most 5 000 to-dos and notes together (409 past that).

## Mail

Only for the Gmail accounts added in Settings → Apps → Gmail. Ids are Gmail's `X-GM-MSGID` as decimal strings.

| Call | Takes | Gives |
| --- | --- | --- |
| `GET /v1/mail/accounts` | | `[{ email, label, status, error, unread }]` |
| `GET /v1/mail/search` | `q` (Gmail's search syntax), `account` (all if absent), `limit` (≤ 50) | `{ messages: [{ account, id, thread, messageId, from, subject, date, unread, snippet, url }] }` |
| `GET /v1/mail/message` | `account`, `id`, `thread=1` | `{ account, thread, messages: [{ id, from, to, cc, date, subject, body, attachments, … }] }` |
| `POST /v1/mail/draft` | `account`, `to[]`, `cc[]`, `subject`, `body` (plain text), `reply_to` (an id) | Saves a draft in Gmail and puts it on the island with **Send**, **Open in Gmail** and **Discard** |

There is no call that sends mail. Only the user's press on **Send** does.

## Claude Code sessions

| Call | Takes | Gives |
| --- | --- | --- |
| `GET /v1/sessions` | `folder` (a project folder's name, any case), `limit` (1 to 30) | `{ sessions: [{ id, folder, title, cwd, updated, openInTerminal }] }`, newest first |
| `POST /v1/sessions/open` | `id`, `in` (`chat` or `terminal`) | Opens it in the island's chat, or brings its terminal forward |
| `POST /v1/folders/open` | `path` (an absolute folder, never a file) | Shows it in File Explorer |

## Limits

- Text past a limit is cut where the tables say "≤"; a list or detail past one is refused (400) and nothing changes.
- The feed keeps the newest 300 notifications, in `%LOCALAPPDATA%\winotch\apps.json`.
- An unknown app is 404 (`register it first`); a wrong or missing token is 401.
