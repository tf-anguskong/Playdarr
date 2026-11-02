# Admin Quick Start

A checklist for a brand-new install, ending with a working admin panel and a Discord test message. Allow about 15 minutes.

## 1. Prerequisites

- A Plex Media Server reachable on your LAN.
- Docker with Compose (recommended), or Node.js 18+.
- A way to serve Playdarr over **HTTPS** if guests will join from outside your network (NGINX, Caddy, Traefik, Tailscale…). The README has a sample NGINX config; WebSocket upgrade headers are required.
- *Optional:* an HDHomeRun tuner for Live TV.

## 2. Configure

```bash
git clone https://github.com/tf-anguskong/Playdarr.git
cd Playdarr
cp .env.example .env
```

Edit `.env`. These are the values you must set:

| Variable | What to put |
|---|---|
| `SESSION_SECRET` | A long random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLEX_URL` | Your Plex server's **LAN** address as seen from the container, e.g. `http://192.168.1.100:32400` or `http://host.docker.internal:32400` |
| `PLEX_TOKEN` | Plex → Settings → Troubleshooting → *Your Plex Token* |
| `APP_URL` | The public address people will use, e.g. `https://playdarr.example.com` |
| `COOKIE_SECURE` | `true` only when served over HTTPS; `false` for plain `http://` |
| `PLEX_CLIENT_ID` | Any unique, stable string, e.g. `my-playdarr` (the server won't start without it) |

> **Heads-up:** `COOKIE_SECURE=true` over plain HTTP makes sign-in appear to succeed and then bounce back to the login page. Match it to how you actually serve the site.

`APP_URL` matters more than it looks: it builds the Plex sign-in callback **and** every link in Discord notifications and calendar invites.

## 3. Start it

```bash
docker compose up --build -d
docker compose logs -f
```

You should see `Playdarr running on port 3000`. Open `http://localhost:3000` (or your `APP_URL`).

## 4. Sign in as the owner

Click *Sign in with Plex* and use the account that **owns** the Plex server. Once you're in the lobby you should see:

- a small amber **admin** badge next to your name, and
- an **Admin** button in the header.

If not, go to [Becoming an Admin](Becoming-an-Admin).

## 5. Add a Discord webhook (optional, 3 minutes)

1. Click **Admin** → *Add webhook*.
2. Paste a Discord webhook URL (see [Webhooks and Notifications](Webhooks-and-Notifications#create-the-discord-webhook)).
3. Tick *A watch night is scheduled* and *A watch night is about to start*.
4. *Save*, then *Send test*. A message should appear in your channel.

## 6. Smoke test

1. In the lobby, click *+ Create Room*, make a **Movie** room and pick something. Open the invite link in a private window, enter a name, and join as a guest.
2. Play, pause and seek as host; the guest should follow.
3. Click *Schedule*, pick a time 30 minutes ahead with *Repeat: Every week*. Confirm the webhook message arrives and the card shows calendar links.
4. Back in **Admin**, check the room appears under *Live rooms* and the schedule under *Scheduled & recurring*.

## 7. Optional extras

- **Live TV:** [Live TV Administration](Live-TV-Administration).
- **Hide room types** you don't want: set `ROOM_TYPE_TV=false`, `ROOM_TYPE_YOUTUBE=false`, etc.
- **Default timezone for schedules:** `DEFAULT_TIMEZONE=America/New_York`.
- **Back up** `scheduled.json`, `webhooks.json` and `users.json`: [Data, Backups and Updates](Data-Backups-and-Updates).
