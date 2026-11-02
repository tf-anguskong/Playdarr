# Troubleshooting

Start with the logs. Most problems show up there:

```bash
docker compose logs --tail 100
docker compose logs -f                       # follow live
docker compose logs | grep -E "Auth|Webhooks|Scheduler|Room|Vote|HDHR"
```

## Signing in

| Symptom | Cause and fix |
|---|---|
| Sign in "works" then returns to the login page | `COOKIE_SECURE=true` while using plain `http://`, or the reverse. Match `COOKIE_SECURE` to how you actually serve the site, then recreate the container |
| `…/login?error=access` | That Plex account doesn't have access to **your** server. Share the library with them in Plex, or check `PLEX_URL` points at the right server |
| `…/login?error=plex` or `error=no_token` | Playdarr couldn't reach plex.tv, or the sign-in wasn't completed. Check outbound internet from the container and try again |
| Server won't start: "SESSION_SECRET … at least 32 characters" | Set a longer `SESSION_SECRET` |
| Server won't start: "PLEX_CLIENT_ID env var must be set" | Add any stable string as `PLEX_CLIENT_ID` |
| Redirect goes to the wrong address after Plex login | `APP_URL` is wrong. It must be the address people actually use |
| Everyone is signed out after a restart | `SESSION_SECRET` changed, or the data volume was lost |

## Admin

| Symptom | Cause and fix |
|---|---|
| No admin badge / Admin button | Sign out and back in with the account that **owns** the Plex server — see [Becoming an Admin](Becoming-an-Admin) |
| `/admin` bounces to the lobby | Not signed in as the owner |
| An API call returns `403 Server owner only` | Same: the session isn't admin |
| *Reset nickname* didn't change what they see | It applies on that person's **next page load** |
| *Kick* does nothing to a host | By design — close the room instead |

## Rooms and playback

| Symptom | Cause and fix |
|---|---|
| Video won't load / endless spinner | Check Plex is reachable at `PLEX_URL` from the container: `docker exec playdarr node -e "require('axios').get(process.env.PLEX_URL+'/identity').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"`. Also check Plex can transcode that file |
| Posters/artwork missing | Same Plex connectivity issue |
| Audio sounds slowed, deep or warbly until you refresh | The page was nudging its playback speed to stay in sync and the speed didn't return to normal (it used to stick when a viewer was promoted to host). Fixed; if you still see it, open the browser console and run `document.getElementById('video-player').playbackRate` — anything other than `1` while the room is in sync is a bug worth reporting |
| Viewers drift out of sync | Check the viewer list's `+0.3s`-style badges; persistent red usually means a weak connection on that viewer |
| Chat or sync stops behind a proxy | The proxy isn't forwarding WebSockets. It needs `Upgrade`/`Connection: upgrade` headers and long read timeouts (see the NGINX sample in the README) |
| Room vanished | Rooms close ~30 s after the host leaves with no one to take over, and on every container restart |
| Guest can't join: "Invite expired" | One-off night cancelled or room closed. Recurring nights keep their link until the series is cancelled |
| Guest sees "Waiting for the host" on a scheduled night | A guest can't be the first in; a Plex user has to open the room first |

## Scheduling

| Symptom | Cause and fix |
|---|---|
| Recurring night didn't open | Server was down more than 6 hours late — it skips to the next one. Check `docker compose logs | grep Scheduler` |
| Time is off by an hour in a calendar app | Older calendar clients and time zones; the Playdarr schedule itself keeps local time across DST |
| Skipped the wrong night | There's no undo; cancel the series and re-create it, or wait — the next occurrence follows the usual interval |

## Webhooks

See the [troubleshooting table on the webhooks page](Webhooks-and-Notifications#troubleshooting-webhooks). Quick checks: *Send test* works? *Enabled* ticked? Right events ticked? `APP_URL` set?

## Live TV

See [Live TV Administration](Live-TV-Administration#troubleshooting-live-tv).

## Always-on rooms

See [Always-On Rooms](Always-On-Rooms#troubleshooting).

## Voting and "Recently added"

| Symptom | Cause and fix |
|---|---|
| "Only N movies match those filters" | Loosen the vote filters (fewer genres, longer maximum length, wider years) |
| Vote button missing | It's host-only and for **movie** rooms |
| *Recently added* strip empty | Plex unreachable, or the room type is turned off (`ROOM_TYPE_MOVIE` / `ROOM_TYPE_TV`) |
| Clicking a card says it couldn't load the title | Plex couldn't return that item (moved or removed). Refresh; the list caches for about 2 minutes |

## Performance

| Symptom | Cause and fix |
|---|---|
| "Live TV is full right now" | You've reached `LIVETV_MAX_ROOMS` (default 2). Wait for a room to end, or raise it in `.env` (up to your tuner count and what your CPU/GPU can encode) |
| High CPU during Live TV | Software encoding is about one core per room — use [GPU encoding](Live-TV-Administration#hardware-encoding-intel-or-amd-igpu) |
| Disk filling | Live TV recordings are ~3–4 GB per room-hour; close idle Live TV rooms; they're deleted on close and at startup |

## Still stuck?

Collect these and open an issue on GitHub (hide tokens and webhook URLs):

- the output of `docker compose logs --tail 200`,
- your `.env` **with secrets removed**,
- what you did, what you expected, and what happened.
