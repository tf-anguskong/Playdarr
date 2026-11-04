# Webhooks and Notifications

Playdarr can post to a Discord channel (or any service that accepts JSON) when something happens. The most useful message is the **reminder**: shortly before a watch night starts, it posts the invite link so people can click straight in.

Everything is configured at **Admin → Webhooks**. Webhooks are admin-only.

## Create the Discord webhook

You need the *Manage Webhooks* permission in the Discord server.

1. In Discord, open the channel's **Edit Channel** (gear icon) → **Integrations** → **Webhooks** → **New Webhook**.
2. Give it a name and, if you like, an avatar (Playdarr's logo is in the repo's `images/` folder).
3. Click **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/123456789/abcDEF…`.

> **Treat that URL like a password.** Anyone who has it can post to your channel. Playdarr stores it in a private file and never shows it again after you save (you only see a hint such as `discord.com/…Ttoken`). If it leaks, delete the webhook in Discord and make a new one.

## Add it in Playdarr

1. **Admin → + Add webhook**.
2. **Name**: anything you'll recognise ("Movie night channel").
3. **Type**: *Discord*.
4. **Webhook URL**: paste it.
5. **Send when**: tick the events you want (below).
6. **Reminder lead time**: how long before a night starts the reminder goes out.
7. Keep *Enabled* ticked and press **Save**, then **Send test**.

The status line under the webhook then shows the last result, e.g. `✓ HTTP 204 · 11/2/2026, 10:00:15 AM`.

You can add several webhooks (for example a #movie-night channel with reminders and an #admin channel that only hears about new rooms). Each has its own events and lead time.

## Events

| Event | When it fires | Good for |
|---|---|---|
| **A watch night is scheduled** | Someone schedules a night (including recurring ones, once at creation) | Announcing the plan |
| **A watch night is about to start** | N minutes before the start (see lead time) — once per night, **including every occurrence of a recurring night** | The "doors open, here's the link" reminder |
| **A scheduled room has opened** | The moment the scheduled time arrives and the room is created | "We're live" |
| **A room is created** | Any Plex user creates a room on the spot | Letting an admin channel see activity |

Every message includes the **invite link** (built from `APP_URL`, so set that to your public address).

### Reminder lead times

Choose from **5, 10, 15, 30, 60, 120 minutes or 1 day** before the start. Details worth knowing:

- Playdarr checks every 30 seconds, so a reminder lands within about half a minute of the lead time.
- Each webhook gets **one reminder per night**. The fact it was sent is saved to disk, so restarting the server doesn't repeat it.
- If a night is scheduled *closer* to the start than your lead time (say 10 minutes away with a 60-minute lead), the reminder goes out right away on the next check.
- If the server is down at the moment a reminder is due, it's sent when it comes back **as long as the night hasn't started yet**.
- Recurring nights get a fresh reminder for each occurrence.

## What the messages look like

### Discord

The same card Discord shows when someone pastes the invite link, in Playdarr amber. A small line on top says what happened (*Playdarr · New room*, *Watch night scheduled*, *Starting soon*, *Doors are open*), then:

- **Title** — what's on: 🎬 movie (year), 📺 show — S·E, 🔴 Live on a channel, ▶ YouTube, or 📅 the night's name.
- **Facts** — rating, runtime and genres; play status; *Hosted by …* and how many are watching; the tagline or a short summary.
- **Artwork** — the title's Plex backdrop as a large image (Live TV: the channel logo as a thumbnail). Discord fetches it from `APP_URL/join/<token>/preview.jpg`, so `APP_URL` must be reachable from the internet for pictures to appear.
- **Links** — **Join the room**, and for scheduled nights also *Add to calendar* (`.ics`) and *Google Calendar*.

Times use Discord's own timestamp markup, so each reader sees them in **their own time zone**, plus a live "in 15 minutes" countdown. Example reminder:

> Playdarr · Starting soon
> **📅 Friday Night Movies**
> ⏰ Doors open in 15 minutes · 8:00 PM
> Hosted by Tyler
> Showing: Resident Evil (2026)
>
> A new era of evil.
>
> **[Join the room](https://playdarr.example.com/join/…)** · [Add to calendar](…) · [Google Calendar](…)

If Playdarr can't build the card (Plex is slow or down), it falls back to a short text embed with the same invite link.

### Generic JSON

Pick **Generic JSON** to send a plain POST to any endpoint (Home Assistant webhook automations, n8n, Node-RED, your own script…). The body looks like this:

```json
{
  "event": "schedule.reminder",
  "title": "⏰ Starting soon: Friday Night Movies",
  "message": "Doors open 2026-11-07T04:00:00.000Z — …",
  "url": "https://playdarr.example.com/join/0f3c…",
  "image": "https://playdarr.example.com/join/0f3c…/preview.jpg?v=123",
  "data": {
    "name": "Friday Night Movies",
    "scheduledFor": "2026-11-07T04:00:00.000Z",
    "timezone": "America/Los_Angeles",
    "recurrence": "weekly",
    "movieTitle": null,
    "createdBy": "Tyler",
    "url": "https://playdarr.example.com/join/0f3c…",
    "calendar": {
      "ics": "https://playdarr.example.com/join/0f3c…/event.ics",
      "google": "https://calendar.google.com/calendar/render?…"
    }
  }
}
```

- `image` is the artwork URL (or `null`) — the same picture the Discord card uses.

- `event` is one of `schedule.created`, `schedule.reminder`, `schedule.started`, `room.created`.
- `scheduledFor` is an ISO-8601 UTC time; `recurrence` is `null`, `"weekly"` or `"biweekly"`.
- `room.created` payloads carry `name`, `createdBy` and `url` only.
- Playdarr sends `Content-Type: application/json` and does **not** sign requests, so put the secret in the URL path or query if your receiver needs authentication.

## How delivery behaves

- Delivery is **best-effort**. Each message has an 8-second timeout, redirects aren't followed, and there is **no retry queue**: if the receiver is down at that moment, the message is lost (the failure is shown in the status line and logged).
- One exception: if Discord answers `429 Too Many Requests`, Playdarr waits the time Discord asked for (up to 5 seconds) and tries once more.
- A failing webhook never affects scheduling or rooms.

## Managing webhooks

| Task | How |
|---|---|
| Change events or lead time | *Edit*, adjust, *Save* |
| Replace a leaked or rotated URL | *Edit*, paste the new URL, *Save* |
| Pause without losing settings | *Edit*, untick *Enabled* |
| Test | *Send test* (always sends a sample reminder, regardless of the events you ticked) |
| Remove | *Delete* |

## Troubleshooting webhooks

| Status line | Meaning and fix |
|---|---|
| `✓ HTTP 204` | Success (Discord replies 204 with no body) |
| `✕ HTTP 404` | The webhook was deleted in Discord — create a new one |
| `✕ HTTP 401` / `403` | The token part of the URL is wrong or revoked — re-copy it |
| `✕ HTTP 429` | Discord is rate-limiting you; it retried once. Reduce how many webhooks hit the same channel |
| `✕ ENOTFOUND` / `EAI_AGAIN` | The container can't resolve the host — check DNS/network from Docker |
| `✕ ECONNREFUSED` / `ETIMEDOUT` | The receiver isn't reachable from the container (for a LAN service, use its LAN IP, not `localhost`) |
| Test works but no reminder arrives | Check the *About to start* event is ticked, the lead time, that the night is in the future, and the webhook is *Enabled* |
| Link in the message is wrong | `APP_URL` is unset or wrong — fix it and restart |

Logs: `docker compose logs | grep Webhooks` shows loads and failures.
