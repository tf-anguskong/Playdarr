# Playdarr setup guide for AI assistants

**For people:** point your AI assistant (Claude, ChatGPT, Copilot, Cursor, …) at this file and say *"help me set up Playdarr"*. For example:

> Read https://github.com/tf-anguskong/Playdarr/blob/master/AIPROMPT_SETUP.md and help me install Playdarr.

> **Before you start: you need a working Plex Media Server on your local network (LAN).** Playdarr doesn't include or install Plex. It connects to a Plex server you already run, streams from its libraries and signs people in with Plex accounts. Plex must already be installed, signed in to your Plex account and have at least one library, on a machine the Playdarr host can reach over the LAN. If you don't have that yet, set up Plex first (plex.tv → *Plex Media Server*) and come back.

**For the assistant:** everything below is written for you. Walk the user through installing Playdarr, a self-hosted watch-party web app for Plex, one step at a time. Ask the interview questions first, then carry out (or tell the user to carry out) each step, and check it worked before moving on. The [README](README.md) and the [Admin Guide](wiki/Home.md) have more detail; this file is the short path.

---

## Rules for the assistant

- **Secrets stay out of chat.** `PLEX_TOKEN`, `SESSION_SECRET` and `GIPHY_API_KEY` belong only in the `.env` file. If you can run commands on the user's machine, generate `SESSION_SECRET` yourself and write it straight into `.env`. Ask the user to paste their Plex token into `.env` themselves rather than into the conversation, and never repeat a secret back.
- **Never commit `.env`.** It's already in `.gitignore`; keep it that way.
- **One step at a time.** Confirm each step's check passes before the next. Most failed installs are a wrong `PLEX_URL`, `APP_URL` or `COOKIE_SECURE`.
- **Don't open ports or change firewall/router settings** without the user saying so. Exposing Playdarr to the internet is optional and is the user's decision.
- **Use the provided Docker setup.** Don't rewrite the `Dockerfile` or `docker-compose.yml` unless the user asks.
- If something here contradicts the README or `.env.example`, trust those and tell the user this file may be out of date.

---

## 1. Interview the user

Ask these before changing anything. The answers decide the values in step 3.

0. **Do they already have a Plex Media Server running on their LAN,** signed in to their Plex account (ideally as the owner) and with at least one movie or TV library? **This is required.** Playdarr is an add-on to an existing Plex server, not a replacement for it. If the answer is no, stop and help them install and set up Plex Media Server first. Don't continue with Playdarr until Plex is up and playing media on its own.
1. **Which machine will run Playdarr,** and what OS (Linux, Windows, macOS, a NAS, Unraid, a Proxmox LXC…)? Is Docker with Compose installed? (Docker is strongly recommended; Node.js 18+ also works.)
2. **Where is Plex?** On that same machine (installed directly or in its own container), or on another machine on the LAN? What is its LAN IP?
3. **Who will watch?** Only people on the home network, or friends over the internet? If over the internet: do they already have a domain and a reverse proxy (NGINX, NGINX Proxy Manager, Caddy, Traefik) or a tunnel (Tailscale, Cloudflare Tunnel) with HTTPS?
4. **Live TV?** Do they have an HDHomeRun tuner set up as a DVR in Plex? How many tuners does it have? Does the Docker host have an Intel or AMD integrated GPU (Linux only) for hardware encoding?
5. **Optional extras:** GIFs in chat (needs a free Giphy API key), default time zone for scheduled nights (e.g. `America/New_York`).

Only the **Plex server owner's** account becomes the Playdarr admin, and only accounts with access to that Plex server can sign in and create rooms. Guests join by invite link without a Plex account. Mention this if the user expects something else.

---

## 2. Check the prerequisites

```bash
docker --version
docker compose version
git --version
```

Check the machine can reach Plex on its LAN address (replace the IP):

```bash
curl -s http://192.168.1.100:32400/identity
```

An XML reply containing `machineIdentifier` means Plex is reachable. No reply means the IP is wrong or a firewall is in the way; fix that first.

---

## 3. Get the code and write `.env`

```bash
git clone https://github.com/tf-anguskong/Playdarr.git
cd Playdarr
cp .env.example .env
```

Fill in `.env`. The required values:

| Variable | What to set |
|---|---|
| `SESSION_SECRET` | 64 random hex characters (at least 32 characters, or the server won't start). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` or `openssl rand -hex 32`. |
| `PLEX_URL` | Plex's **LAN** address *as seen from inside the container*; see the table below. **Never** the public/external Plex address: video would loop out through the internet and back. |
| `PLEX_TOKEN` | The user's Plex token. In Plex Web, open any item → *⋯* → *Get Info* → *View XML*; the token is the `X-Plex-Token=` value in the URL. (Plex's support article "Finding an authentication token" has other ways.) |
| `PLEX_CLIENT_ID` | Any stable, unique string, e.g. `playdarr-<their-name>`. Required; don't change it later. |
| `APP_URL` | The exact address people will type to open Playdarr; see the second table. Plex sign-in redirects back here, and invite links use it. |
| `COOKIE_SECURE` | `true` only if Playdarr is served over **https**; `false` for plain `http://`. Getting this wrong makes sign-in silently bounce back to the login page. |

**`PLEX_URL`, by where Plex runs:**

| Plex runs… | `PLEX_URL` |
|---|---|
| On the same machine, Docker Desktop (Windows/macOS) | `http://host.docker.internal:32400` |
| On the same Linux machine (installed directly or in a host-network container) | `http://host.docker.internal:32400` (the compose file maps it to the host), or the host's LAN IP |
| In its own Docker container with a published port | The host's LAN IP, e.g. `http://192.168.1.100:32400` |
| On another machine | That machine's LAN IP, e.g. `http://192.168.1.100:32400` |

**`APP_URL` and `COOKIE_SECURE`, by who will watch:**

| Setup | `APP_URL` | `COOKIE_SECURE` |
|---|---|---|
| Trying it on the same computer | `http://localhost:3000` | `false` |
| Home network only | `http://<docker-host-LAN-IP>:3000` | `false` |
| Over the internet behind an HTTPS reverse proxy or tunnel | `https://playdarr.their-domain.com` | `true` |

Optional values worth setting now: `DEFAULT_TIMEZONE` (IANA name), `GIPHY_API_KEY` (from developers.giphy.com: create an **API** app, not SDK), and `ROOM_TYPE_TV` / `ROOM_TYPE_YOUTUBE` = `false` to hide room types they don't want.

**If the user is not setting up Live TV,** comment out the example `HDHR_IP=` and `LIVETV_PLEX_HOST=` lines that `.env.example` ships with, and leave `ROOM_TYPE_LIVETV=false`.

Most other settings can be changed later in the browser at **Admin → Settings**. Anything set in `.env` takes priority there and is shown as locked.

---

## 4. Start it

```bash
docker compose up --build -d
docker compose logs -f
```

Success looks like the log line `Playdarr running on port 3000`. Then confirm Plex is reachable *from inside the container*:

```bash
docker exec playdarr node -e "require('axios').get(process.env.PLEX_URL+'/identity').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"
```

`OK 200` is good. `FAIL` means `PLEX_URL` is wrong for the container; revisit the table in step 3.

If the container exits immediately, read the logs: `SESSION_SECRET … at least 32 characters` and `PLEX_CLIENT_ID env var must be set` are the usual causes.

After any `.env` change, recreate the container with `docker compose up -d` (a plain restart doesn't reload `.env`).

---

## 5. First sign-in

1. Open `APP_URL` in a browser and click **Sign in with Plex**.
2. Sign in with the account that **owns** the Plex server. In the lobby they should see an amber **admin** badge and an **Admin** button.
3. Smoke test: *+ Create Room* → **Movie** → pick something. Open the room's invite link in a private window, join as a guest, and check that play/pause/seek by the host is followed by the guest.

If sign-in bounces back to the login page, `COOKIE_SECURE` doesn't match http/https. If it lands on the wrong address, `APP_URL` is wrong. If it says the account has no access, that Plex account isn't shared on this server.

---

## 6. Optional: make it reachable from the internet

Only if the user wants friends outside the home network. Playdarr needs **HTTPS** and **WebSockets** (Socket.io) through the proxy.

- **NGINX:** the repo's [`nginx.conf`](nginx.conf) is a working example (WebSocket upgrade headers, long read timeouts, buffering off).
- **NGINX Proxy Manager:** add a proxy host to the Docker host's IP, port 3000, with *Websockets Support* on and a Let's Encrypt certificate.
- **Caddy:** `playdarr.example.com { reverse_proxy <docker-host-IP>:3000 }` is enough; Caddy handles HTTPS and WebSockets.
- **Tunnels** (Cloudflare Tunnel, Tailscale Funnel) work too; point them at port 3000.

Then set `APP_URL=https://…` and `COOKIE_SECURE=true` in `.env` and run `docker compose up -d`.

---

## 7. Optional: Live TV

Needs an HDHomeRun that's set up as a DVR in Plex (Plex supplies the channel guide; video comes straight from the tuner). In `.env`:

```env
ROOM_TYPE_LIVETV=true
HDHR_IP=192.168.1.115          # the tuner's LAN IP
HDHR_PORT=5004
LIVETV_MAX_ROOMS=2             # at most the number of tuners
# LIVETV_PLEX_HOST=http://192.168.1.100:32400   # only if the DVR is on a different Plex server than PLEX_URL
```

Each Live TV channel being watched holds one tuner and is encoded by ffmpeg in the container, roughly one CPU core per HD channel. On a **Linux** host with an Intel or AMD iGPU, hardware encoding saves most of that: add `LIVETV_HWACCEL=vaapi` to `.env` and start with

```bash
docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up --build -d
```

Check it with `docker exec playdarr vainfo` (should list H.264 encode entries) and `docker compose logs | grep "enc="` (should say `enc=vaapi`). Each room also records up to an hour to disk (about 3–4 GB), so the Docker volume needs the space. Details: [Live TV Administration](wiki/Live-TV-Administration.md).

---

## 8. Hand-off notes for the user

Tell the user:

- **Updating:** `git pull` then `docker compose up --build -d`. (If they switched `docker-compose.yml` to the published image `ghcr.io/tf-anguskong/playdarr:latest` — x86-64 and ARM64 — it's `docker compose pull` then `docker compose up -d`.)
- **Data:** everything persistent (sessions, settings, scheduled nights, webhooks, people) lives in the Docker volume mounted at `/data`. Rooms and chat are in memory and end on restart, by design. Backups: [Data, Backups and Updates](wiki/Data-Backups-and-Updates.md).
- **Admin panel** (`/admin`, owner only): Discord webhooks, people and nicknames, always-on rooms, and the Settings page.
- **Android TV app:** [Playdarr for Android TV](https://github.com/tf-anguskong/Playdarr-AndroidTV) connects to this server.
- **Problems:** [Troubleshooting](wiki/Troubleshooting.md). Start with `docker compose logs --tail 100`.
