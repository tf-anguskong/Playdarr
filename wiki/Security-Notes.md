# Security Notes

What protects your server, what to configure, and what to be aware of.

## The essentials checklist

- [ ] `SESSION_SECRET` is long and random, and never committed to Git.
- [ ] Playdarr is served over **HTTPS** (a reverse proxy or tunnel), and `COOKIE_SECURE=true`.
- [ ] `PLEX_URL` is your **LAN** address, not your public domain.
- [ ] `.env` and your backups are kept private.
- [ ] Webhook URLs aren't pasted into chats or screenshots.

## Sign-in and who can do what

| Role | How they get in | Can do |
|---|---|---|
| **Owner (admin)** | Signs in with the Plex account that owns the server | Everything, including the [Admin Panel](Admin-Panel) |
| **Plex user** | Signs in with a Plex account that has access to your server (checked at sign-in) | Create and schedule rooms, join any room, host |
| **Guest** | Invite link + a display name | Join that room, chat, react; can be given host of it. Cannot create or schedule rooms or see the lobby |

- Sign-in uses Plex's PIN flow. The PIN is tied to the browser that started the sign-in, so only that browser can finish it. At sign-in Playdarr confirms the account actually has access to *your* server; if not, it's refused.
- When a host picks a movie or episode (or a night is scheduled with one), the server looks the title and file up in Plex itself; the browser only says which item.
- A guest's session only works for **the room its invite points at**, and only for what that room is playing. It can't stream other titles or other rooms, and it stops working when the room closes.
- The admin flag lives in the **server-side session**, and every admin route and socket action re-checks it. Browsers can't grant it to themselves.
- The `/auth` endpoints are rate-limited (30 requests per 15 minutes per IP) to blunt guessing.
- Sessions last 7 days.

## Plex credentials

- `PLEX_TOKEN` is a **server-level secret**. It stays on the server: video and artwork are proxied, and the proxy strips Plex tokens from everything it forwards to browsers.
- Users' own Plex tokens are stored **encrypted** in their session and used only to check access at sign-in.
- The proxy only forwards Plex transcode and media-part paths, checked after the address is fully resolved (so `../` tricks can't reach other Plex endpoints). Guests can only fetch the transcode their room started.

## Invite links are bearer links

Anyone who has a room's invite link can join as a guest. Treat links like keys:

- Share them where you'd share the room itself.
- **Closing a room invalidates its link.** A recurring night's link persists until the series is cancelled.
- For an **always-on room**, whoever holds the link can be the first in and become its host (and so tune its channel or pick what plays). Don't post those links publicly.
- **Link previews show what's on.** When an invite (or room) link is pasted into Discord, Slack, iMessage and similar apps, the preview card shows the title playing, its artwork and summary, play/pause status, the host's display name and how many people are watching (never other viewers' names). A scheduled night's card shows its time, host and pre-picked title. Artwork is served through Playdarr, so your Plex token isn't exposed.
- A recurring night's `.ics` file (`/join/<token>/event.ics`) is fetchable by anyone with that same link.
- You can kick and block someone, but a kicked **guest** can re-enter via the link with a new identity — close the room if you need to shut them out.

## Webhook secrets

- Webhook URLs are stored in `webhooks.json` (file mode 600, readable only by the app's user).
- They are **never sent back to the browser** after saving, only a short hint.
- Only the owner can add, edit, test or delete webhooks.
- Playdarr will POST to any `http`/`https` URL the owner enters, including LAN addresses (useful for Home Assistant). That's intentional — only the owner can configure it.
- Rotating a leaked URL: create a new webhook in Discord, *Edit* the webhook in Playdarr and paste the new URL.

## Settings page limits

The Settings page can't be used to run arbitrary programs or write files: *Custom encoder options* only accepts known video-encoder options, each with a single value, so it can't add ffmpeg outputs, inputs or filters. Saved settings are re-checked at every startup, and one that no longer passes is ignored (the log says which).

## Browser protections

Playdarr sends security headers (CSP, frame blocking, HSTS when `COOKIE_SECURE=true`). The Content Security Policy restricts where scripts, frames and media can load from: only itself and YouTube for embeds. Images may load from any HTTPS address (Plex avatars, Giphy, channel logos), but chat can only show GIFs the server looked up on Giphy itself and images it re-encoded — never a URL someone typed. If you add a custom reverse-proxy header policy, don't strip these.

## Chat images and GIFs

- **Uploads** are decoded and re-saved by the server (PNG, JPEG, WebP or GIF only; SVG is refused because it can carry script), so what's served is always Playdarr's own WebP file, not the bytes someone sent. They're limited to 8 MB and 8 per minute per person.
- They aren't screened for content. If guests can't be trusted with that, set *Image uploads in chat* to *Plex users only* or *Off*; hosts and you can delete and mute.
- The **Giphy key** stays on the server: browsers search through Playdarr, and posting names a GIF by id, which the server checks against your rating.

## Privacy: what Playdarr remembers about people

| Data | Where | Notes |
|---|---|---|
| Plex ID, Plex display name, avatar URL | `users.json` | Plus nickname, first/last seen, sign-in count |
| Email address | **Not stored** | |
| Chat | **Memory only, per room** | The last 100 messages are kept while the room is open (so late joiners see them) and gone when it closes or the server restarts. Users can export a `.txt` themselves |
| Images posted in chat | `chat-uploads/<room>/` | Re-encoded (location and other metadata removed), only served to people in that room, deleted with the message, when the room closes and on every start |
| Guests | **Not stored** | Anonymous per-invite identities |
| Watch history | **Not stored** | |

To forget everyone, stop the container and delete `users.json`.

## Hardening ideas

- Put Playdarr behind a proxy that rate-limits by IP, or behind a VPN/Tailscale if guests only come from known networks.
- Keep Docker images and the host OS updated; rebuild Playdarr regularly (`git pull && docker compose up --build -d`) to pick up dependency updates.
- Restrict who has access to your Plex server: anyone with access can sign in to Playdarr.
- Review the logs occasionally — admin actions are logged with who did them: `docker compose logs | grep -E "\[Admin\]|\(admin\)"` shows webhook changes, nickname changes, room closes, cancelled nights and owner kicks; `grep "\[Room\]"` also shows renames, mutes and removed messages.
