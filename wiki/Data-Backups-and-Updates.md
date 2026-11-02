# Data, Backups and Updates

## What Playdarr stores

Everything lives under `DATA_PATH` (`/data` in the container), which Docker Compose keeps in a named volume called `sessions` (the real name is prefixed with your project folder, e.g. `movienight_sessions` or `playdarr_sessions` — find it with `docker volume ls`).

| Path in `/data` | What it is | Worth backing up? |
|---|---|---|
| `scheduled.json` | Upcoming and recurring watch nights, including their invite links | **Yes** |
| `webhooks.json` | Your webhooks (URLs are secrets; file mode 600) and last delivery status | **Yes** |
| `users.json` | The people list and their nicknames | **Yes** |
| `always-on.json` | Always-on rooms (name, type, pinned channel, permanent invite link) | **Yes** |
| `settings.json` | Settings saved from the admin [Settings page](Settings-Page) | **Yes** |
| `sessions/` | Sign-in sessions (7-day lifetime) | No — people just sign in again |
| `dvr/` | Live TV recordings | No — temporary; wiped when the server starts |

**Not saved at all:** ordinary rooms. They live in memory, so restarting the container closes every open room. (Always-on rooms are the exception: they're recreated, empty, from `always-on.json`.) Plan updates for when nobody is watching.

## Back up

The three files that matter are tiny. From the project folder, with the container running or stopped:

```bash
# Replace movienight_sessions with your volume name
docker run --rm -v movienight_sessions:/data -v "$PWD":/backup alpine \
  tar czf /backup/playdarr-data-$(date +%F).tgz -C /data scheduled.json webhooks.json users.json always-on.json settings.json
```

(If one of the files doesn't exist yet — for example you've never made a webhook — `tar` will complain about it; drop that name from the command.)

Also keep a copy of your **`.env`** somewhere safe. It's not in Git and holds your Plex token and session secret.

> **Treat backups as secret.** `webhooks.json` contains webhook URLs and `.env` contains tokens.

## Restore

Stop the app, put the files back, start it:

```bash
docker compose stop
docker run --rm -v movienight_sessions:/data -v "$PWD":/backup alpine \
  tar xzf /backup/playdarr-data-2026-11-02.tgz -C /data
docker compose up -d
```

Restoring `scheduled.json` re-arms the schedule on startup. A recurring night that went overdue by more than 6 hours while you were restoring is skipped to its next occurrence.

## Updating Playdarr

```bash
cd Playdarr
git pull
docker compose up --build -d        # add -f docker-compose.yml -f docker-compose.vaapi.yml if you use GPU encoding
docker compose logs -f
```

- **Branches:** `master` is the stable branch; `dev` carries work in progress. Follow `master` unless you want features early.
- **Open rooms close** when the container restarts. Webhooks, schedules and nicknames come back.
- After an update that touches sign-in, **sign out and back in** (the admin flag is set at sign-in).
- If you changed `.env`, use `docker compose up -d --force-recreate` so the new values are read.
- **Rolling back:** `git checkout <earlier-commit>` and rebuild. **Back up the data files first:** an older version doesn't understand newer fields (for example, it would treat a recurring night as a one-off and remove it after it opens).

## Changing what's saved

| I want to… | Do this |
|---|---|
| Forget everyone's nicknames | Stop the container and delete `users.json` (people are re-added as they sign in) |
| Remove all webhooks at once | Delete `webhooks.json` while stopped, or delete them one by one in Admin |
| Clear all schedules | Cancel in the lobby/Admin, or delete `scheduled.json` while stopped |
| Reset everyone's sign-in | Delete the `sessions/` folder (everyone signs in again) |
| Start completely fresh | `docker compose down -v` (**deletes the volume** and everything above) |

> **Heads-up:** edit these files only while the container is **stopped**. The running app holds them in memory and will overwrite your changes.
