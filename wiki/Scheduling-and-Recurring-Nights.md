# Scheduling and Recurring Nights

Scheduling turns Playdarr into a weekly ritual: pick a time, optionally repeat it, and everyone gets a stable invite link, a calendar entry and a reminder.

## Who can schedule?

Only **Plex users** (not guests) — via the *Schedule* button in the lobby. As the owner you can also **cancel or skip anyone's** night.

## Creating a night

In the lobby: **Schedule** →

- **Room name** (e.g. "Friday Night Movies"),
- **Movie** (optional — you can also pick it once the room is open),
- **Date & Time** and **Timezone** (defaults to `DEFAULT_TIMEZONE` from `.env`, falling back to UTC),
- **Repeat**: *Does not repeat*, *Every week*, or *Every 2 weeks*.

On save, the night appears under **Scheduled** and any webhook subscribed to *A watch night is scheduled* announces it.

## The invite link

The link is created **at scheduling time**, so you can share it immediately. Before the room opens, visitors see a waiting page that shows the start time in **their own** time zone, then redirects them automatically when the room opens.

For a **recurring night, the link stays the same every week.** People can bookmark it once.

## When the time arrives

1. The room opens automatically.
2. The **first Plex user to open it becomes the host.** Guests who arrive first see "Waiting for the host to arrive" and can retry.
3. If a movie was picked in advance it's already loaded.
4. Any webhook subscribed to *A scheduled room has opened* posts.
5. If **no Plex user opens it within 6 hours**, the room closes on its own.

If the server was down at the start time, the room opens when it comes back, unless the night is **more than 6 hours late**: a one-off night is then dropped, and a recurring one skips to its next occurrence.

## Recurring nights

| Behaviour | Detail |
|---|---|
| Repeat options | Weekly (7 days) or every 2 weeks (14 days) |
| Time of day | Stays at the **same local time** in the night's timezone, even across daylight-saving changes (8 PM Pacific stays 8 PM) |
| After it opens | The schedule moves itself to the next occurrence straight away |
| Movie | A pre-picked movie applies to the **first** night only; later nights start empty (pick one, or use a [vote](#movie-votes)) |
| Missed nights | If the server was down and a night is **more than 6 hours late**, it's skipped rather than opened late |
| Still open from last time | If last week's room is somehow still open when the next one fires, the existing room is kept |

### Skip and cancel

- **Skip next** moves a recurring night to the following occurrence (handy for a holiday). It does not touch the invite link.
- **Cancel** removes a one-off night. For a recurring one the button reads **Cancel series** and ends it for good.
- Both are available to the creator and to you.

## Calendar invites

Every scheduled night gets calendar links on its lobby card and on the guest waiting page:

- **.ics** — a standard calendar file for Apple Calendar, Outlook, Thunderbird and others,
- **Google** — an *Add to Google Calendar* link.

What's in them: the night's name, a 2-hour block, the invite link in the description and location, a 15-minute alarm, and — for recurring nights — a repeat rule so the entry repeats in the person's calendar too.

- The `.ics` lives at `/join/<invite-token>/event.ics`. **Anyone with the invite link can fetch it**, the same as the link itself.
- Calendar files don't embed a full time-zone definition. Google, Apple and current Outlook handle this; a few older clients may show an unexpected time.
- Calendar entries are *copies*: if you skip or cancel a night in Playdarr, people's own calendar entries aren't updated.

## Reminders

Set up a webhook with the *About to start* event ([Webhooks and Notifications](Webhooks-and-Notifications)) and Playdarr posts the invite link in Discord a set time before each night (5 minutes up to a day). One reminder per night per webhook, recurring nights included.

## Movie votes

Hosts of movie rooms have a **🗳 Movie vote** button: the host chooses filters (genre, rating, length, year, minimum score, deck size), everyone swipes yes/no on a random deck from your Plex library, and the most-liked movie wins. The host can then start it with one click. It pairs well with recurring nights where nobody pre-picks a movie.

## Where it's stored

`scheduled.json` in the data volume. It survives restarts, and timers are re-armed at startup. Include it in [backups](Data-Backups-and-Updates).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Night didn't open | Server was down for more than 6 hours past the start time (a one-off is dropped, a recurring night skips to the next one) — check `docker compose logs | grep Scheduler` |
| Wrong time shown | Timezone picked at creation; the night is stored in that zone and displayed in each viewer's own zone |
| No reminder | See [Webhooks and Notifications](Webhooks-and-Notifications#troubleshooting-webhooks) |
| Guest says "Invite expired" | The one-off night was cancelled, or the room was closed. Recurring nights keep the link until the series is cancelled |
