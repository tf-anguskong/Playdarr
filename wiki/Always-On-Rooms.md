# Always-On Rooms

An **always-on room** stays open with nobody in it, listed in the lobby with a permanent invite link. It's set up by the server owner only. Use it for things like a standing "Daytime CBS" Live TV room, or a "Movie Night" room people can drop into at any time.

## How it behaves

- **Always open.** The room is listed in the lobby with an *always on* badge, even when it's empty. It doesn't close when everyone leaves, and it comes back after a server restart.
- **No host needed.** While it's empty it's waiting. **Whoever arrives first becomes host: a Plex user, or a guest using the invite link.** Walking in is all it takes to start it. (Scheduled rooms differ: they make guests wait for a Plex user.)
- **It resets when it empties.** When the host leaves and nobody can take over, the room waits a **10-second grace period** (so a page refresh doesn't tear anything down), then goes back to waiting: no host, host settings and votes cleared, blocks lifted. The invite link never changes.
- **Live TV tunes on first join.** An empty Live TV room runs **nothing**: no tuner, no ffmpeg, no recording, no disk. When the first person arrives it tunes the pinned channel (about 14 seconds, with the usual tuning screen), and when the room empties again the recording is stopped and the tuner is freed. So an always-on Live TV room costs nothing while nobody's watching.
- **Movie and TV rooms** simply stay open and empty. They don't preload anything; whoever hosts picks what to watch.

## Setting one up

**Admin → Always-on rooms → + Add room**

| Field | Notes |
|---|---|
| **Name** | Shown in the lobby |
| **Type** | Live TV, Movie or TV show (only the types you have turned on). YouTube rooms aren't available here because they need a video to exist |
| **Channel** | Live TV only. The channel to tune when someone arrives. Leave it as *No channel* to make an empty Live TV room people pick a channel in. *+ Split with another channel* pins up to 4, and the room opens in [split view](Live-TV-Administration#split-view-several-channels-in-one-room); if split view is turned off or capped lower by then, it tunes the first channels that fit |

Once created it's open straight away. Each row in the list shows:

- the room's state: *Empty — tunes when someone arrives*, or who's hosting and how many are watching,
- **Open** (go in), **Copy link** (the permanent invite link) and **Remove**.

## Removing one

*Remove* closes the room for real: everyone in it is sent to the lobby, the invite link stops working, and it won't come back after a restart.

> **Heads-up:** *Close room* and *Eject everyone* (in the lobby or the Live rooms list) are different from *Remove*. On an always-on room they send everyone out and reset it, but the room stays open and listed.

## Good to know

- **Who can host:** the first person in, including a guest with the link, becomes host and can change the channel, pick movies and so on. When they leave, the room goes back to its pinned channel for the next person. A guest host who refreshes their page re-tunes the room (about 14 seconds), because guests can't be recognised as the same host after a reload.
- **Moderation still works.** You can kick and block people from an always-on room as usual. Blocks last until the room resets.
- **Invite links** are permanent, and anyone holding one can walk in, start the room and host it. Share them only with people you're happy to have do that ([Security Notes](Security-Notes#invite-links-are-bearer-links)).
- **Room type turned off?** If you later set `ROOM_TYPE_LIVETV=false` (or the type of a saved room), that room isn't opened and shows *Not open* in Admin. It comes back when you turn the type on again.
- **Tuners:** a Live TV always-on room only holds a tuner while people are in it, but it competes with other Live TV rooms for them. See [Live TV Administration](Live-TV-Administration#capacity-planning).
- **Webhooks:** always-on rooms don't send *A room is created* messages; they aren't created by a person.

## Where it's stored

`always-on.json` in the data folder (room name, type, pinned channels and invite link). Include it in [backups](Data-Backups-and-Updates).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Room isn't in the lobby after a restart | Its room type is turned off in `.env`, or `always-on.json` wasn't restored — check `docker compose logs | grep AlwaysOn` |
| "Waiting for the host to arrive" | You're seeing a **scheduled** night, not an always-on room: scheduled rooms make guests wait for a Plex user. Always-on rooms let a guest with the link open them |
| Live TV room won't tune | Same causes as any Live TV room: tuners busy, tuner unreachable, guide down. See [Troubleshooting](Troubleshooting#live-tv) |
| Everyone was thrown out and the room is empty | Someone used *Close room* / *Eject everyone*, or the host left and no one else was there. It's working as designed; the room is ready for the next person |
