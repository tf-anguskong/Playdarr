# Admin Panel

Open it from the **Admin** button in the lobby header, or go straight to `/admin`. Anyone who isn't the server owner is redirected to the lobby (and API calls get `403 Server owner only`).

The page has five sections. Everything refreshes live or on a timer, so you can leave it open.

## Webhooks

Send notifications to Discord or any JSON endpoint. Full walkthrough: [Webhooks and Notifications](Webhooks-and-Notifications).

| Control | What it does |
|---|---|
| *+ Add webhook* | Opens the form: name, type, URL, which events, reminder lead time, enabled |
| *Send test* | Posts a sample reminder to that webhook right now and shows the result |
| *Edit* | Change anything. **Leave the URL blank to keep the current one** |
| *Delete* | Removes it |
| Status line | Last delivery result and time (`✓ HTTP 204` is success; a red `✕` shows the failure) |

The URL itself is never shown again after you save it (it's a secret). You only see a short hint such as `discord.com/…Ttoken`.

## Live rooms

Every open room, updated in real time:

- room name, type, host, what's playing, viewer count;
- each viewer as a chip. Click the **✕** on a chip to **kick and block** that person from the room (not shown for the host or other admins);
- *Open* jumps into the room; *Close room* ends it for everyone.

## Always-on rooms

Rooms you pin open so they exist with nobody in them (a standing Live TV channel, a drop-in movie room). Add one with *+ Add room*; each row shows whether it's empty or who's hosting, with *Open*, *Copy link* and *Remove*. Live TV ones tune only when someone arrives. Full details: [Always-On Rooms](Always-On-Rooms).

## People

Every **Plex account** that has signed in:

- avatar, nickname (or Plex name if they never set one), a green dot if they're connected right now;
- last seen, sign-in count, first-seen date;
- search box to filter by name or nickname;
- *Reset nickname* appears when someone has set one. See [Moderation](Moderation#nicknames).

Guests are not listed: each invite gives them a throwaway identity.

## Scheduled & recurring

Every upcoming watch night:

- next occurrence shown in the night's own timezone, plus a *repeats weekly / every 2 weeks* badge;
- *Copy link* (the standing invite link), *Skip next* (recurring only), *Cancel* / *Cancel series*.

See [Scheduling and Recurring Nights](Scheduling-and-Recurring-Nights).

## What isn't here (yet)

- Editing a scheduled night's time (cancel and recreate it).
- Banning someone from *all* rooms, or from the app. Blocks are per room and last until the room closes.
- Managing the Plex server itself. That's what Plex is for.
