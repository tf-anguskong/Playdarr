# Settings Page

**Admin → Settings** (`/admin/settings`, owner only) lets you change the server's configuration from the browser. It covers the options you'd otherwise edit in `.env`, with a friendly name and a short description for each.

## How it works

| You see | It means |
|---|---|
| A normal control (switch, dropdown, box) | Not set in `.env`. Changes **save immediately** and are kept across restarts. |
| 🔒 **Set in .env** and a greyed-out control | This is defined in your `.env` file. **`.env` always takes priority**, so it can't be changed here. Edit `.env` and recreate the container (`docker compose up -d --force-recreate`) to change it. |
| **Customised** and a *Reset* link | You've changed it here. *Reset* goes back to the default. |
| **Applies after a restart** | The server only reads this once at startup. Your change is saved and takes effect after the next restart. Only the *Channel guide server* works this way. |
| **Advanced** | Only needed in unusual setups. |

Good to know:

- **A box left empty means "use the default".** Clearing a field and leaving it is the same as pressing *Reset*.
- **Bad values are refused** with a plain-language message ("Enter a value from 4 to 60"), and the control goes back to what's actually in effect.
- **If you later add a line to `.env` for something you'd set here,** the `.env` value wins and the setting becomes locked. Your saved value is kept, and comes back if you remove the line.
- **The raw variable names never appear** in the page. The table below maps names to settings.
- **Everything is logged:** `docker compose logs | grep "\[Admin\]"` shows who changed which setting.

## What's on the page

### Room types
Turn movie, TV show, YouTube and Live TV rooms on or off. Rooms that are already open keep running. Switching Live TV on or off needs no restart, and an always-on Live TV room opens as soon as you switch the type on.

### Scheduling
The **default time zone** pre-selected when someone schedules a watch night.

### Chat & moderation
The **offensive-word filter** (on/off, extra words to block, words to always allow — see [Moderation](Moderation#offensive-word-filter)), whether a **Giphy API key** is set (it can only be set in `.env`), the **GIF content rating**, and who may post **images** in chat (everyone, Plex users only, or nobody).

### Live TV · source
The **HDHomeRun address** and **port**, the **Live TV source** (automatic, HDHomeRun, or Plex's DVR) and the **channel guide server**. Changing the tuner address applies to the next channel anyone tunes.

### Live TV · capacity
**Most Live TV rooms at once**, the **pause cooldown** and the **playback buffer**. See [Live TV Administration](Live-TV-Administration#limiting-how-many-rooms-stream-livetv_max_rooms). Both apply immediately.

### Live TV · picture quality
Upscaling, sharpening, CPU encoder speed and peak bitrate. These apply to the **next channel tuned**; a room that's already streaming keeps its current encode until it tunes again.

### Live TV · hardware encoding
Intel/AMD hardware encoding, the graphics device, the hardware bitrate and (advanced) a custom encoder option string. These also apply to the next tune. Hardware encoding still needs the GPU passed into the container ([Live TV Administration](Live-TV-Administration#hardware-encoding-intel-or-amd-igpu)).

### Server connection (read-only)
Shows how Playdarr is wired: the Plex server address, public address, whether secure cookies are on, the port and the app identifier. These can't be changed here because getting them wrong can lock you out (for example, a wrong public address breaks sign-in), so edit them in `.env`.

The **secrets** (Plex token, channel guide token, session secret) show only **Configured** or **Not set**. Their values are never sent to your browser. If a URL contains a username and password, those are stripped from what's displayed.

## Which setting is which variable?

| Settings page | `.env` variable | Applies |
|---|---|---|
| Movie rooms | `ROOM_TYPE_MOVIE` | Immediately |
| TV show rooms | `ROOM_TYPE_TV` | Immediately |
| YouTube rooms | `ROOM_TYPE_YOUTUBE` | Immediately |
| Live TV rooms | `ROOM_TYPE_LIVETV` | Immediately |
| Default time zone | `DEFAULT_TIMEZONE` | Immediately |
| Filter offensive words | `WORD_FILTER` | Immediately |
| Also block these words | `WORD_FILTER_EXTRA` | Immediately |
| Always allow these words | `WORD_FILTER_ALLOW` | Immediately |
| Giphy API key (read-only) | `GIPHY_API_KEY` | After a restart (`.env` only) |
| GIF content rating | `GIPHY_RATING` | Immediately |
| Image uploads in chat | `CHAT_UPLOADS` | Immediately |
| HDHomeRun address | `HDHR_IP` | Next tune |
| HDHomeRun port | `HDHR_PORT` | Next tune |
| Live TV source | `LIVETV_SOURCE` | Next tune |
| Channel guide server | `LIVETV_PLEX_HOST` | After a restart |
| Most Live TV rooms at once | `LIVETV_MAX_ROOMS` | Immediately |
| Live TV pause cooldown | `LIVETV_PAUSE_COOLDOWN_SEC` | Immediately |
| Live TV playback buffer | `LIVETV_BUFFER_SEC` | Next tune |
| Upscale low-resolution channels | `LIVETV_UPSCALE` | Next tune |
| Sharpening | `LIVETV_SHARPEN` | Next tune |
| CPU encoder speed | `LIVETV_X264_PRESET` | Next tune |
| Peak video bitrate | `LIVETV_MAX_BITRATE` | Next tune |
| Hardware encoding | `LIVETV_HWACCEL` | Next tune |
| Graphics device | `LIVETV_VAAPI_DEVICE` | Next tune |
| Hardware video bitrate | `LIVETV_VAAPI_BITRATE` | Next tune |
| Custom encoder options (advanced) | `LIVETV_VIDEO_ARGS` | Next tune. Video-encoder options only, one value each — the page refuses anything else |
| Plex server address *(read-only)* | `PLEX_URL` | `.env` only |
| Public address *(read-only)* | `APP_URL` | `.env` only |
| Secure cookies *(read-only)* | `COOKIE_SECURE` | `.env` only |
| Port *(read-only)* | `PORT` | `.env` only |
| App identifier *(read-only)* | `PLEX_CLIENT_ID` | `.env` only |
| Plex access token *(read-only, hidden)* | `PLEX_TOKEN` | `.env` only |
| Channel guide token *(read-only, hidden)* | `LIVETV_PLEX_TOKEN` | `.env` only |
| Session secret *(read-only, hidden)* | `SESSION_SECRET` | `.env` only |

## Where it's stored

`settings.json` in the data folder holds only the values you changed in the UI. It never contains anything from `.env`. Include it in [backups](Data-Backups-and-Updates).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "This is set in your .env file, so it can't be changed here" | The setting is defined in `.env`. Edit `.env` (or remove the line to manage it from the page) and recreate the container |
| I removed a line from `.env` but the setting is still locked | Recreate the container; a plain restart doesn't re-read `.env` |
| I changed a setting but nothing seemed to happen | Check its *Applies* column above: encoder and tuner settings take effect on the **next channel tuned**, and the channel guide server needs a restart |
| The Settings page is missing from the admin header | You're not signed in as the server owner |
