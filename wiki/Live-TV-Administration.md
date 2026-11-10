# Live TV Administration

Live TV rooms let everyone watch the same broadcast channel in sync, with a host who controls playback and a per-room recording buffer so people can pause and rewind.

## How it works

- Video comes **straight from an HDHomeRun tuner** through ffmpeg (bundled in the Docker image). ffmpeg converts the tuner's MPEG-2/AC3 stream into browser-friendly H.264/AAC.
- Each Live TV room records its channel to disk as a rolling **1-hour DVR**. The room's position is a point in that recording, which is how pause, rewind and tight sync work.
- **Plex is used only for the channel guide** (channel list and "now playing" titles).
- Changing channel starts a fresh recording for the room; the old one is thrown away. (In [split view](#split-view-several-channels-in-one-room), changing one tile's channel keeps the recording.)
- A room can show **up to 4 channels at once** in [split view](#split-view-several-channels-in-one-room), each viewer picking which one they hear.

## The lobby's "on now" strip

With Live TV enabled, Plex users see a **Live TV · on now** row in the lobby: channel logo, channel name and the program airing right now, main networks (the `.1` subchannels) first. It refreshes about every two minutes and draws on the same guide data as the in-room channel picker, so it needs the guide (Plex) to be reachable and returns nothing if it isn't.

- Clicking a channel asks *"Start a Live TV room tuned to this channel?"*. On *Create room* the room is named after the channel and **tunes as soon as its host's page connects**, so the tuning screen is visible.
- *More channels* starts an empty Live TV room; pick from the full guide inside it.
- Starting one uses a tuner like any other Live TV room (see capacity below).

## Split view (several channels in one room)

A Live TV room's host can put **up to 4 channels on screen at once**. Everyone sees the same tiled picture, and **each viewer chooses which channel they hear**.

- **Host:** after tuning a channel, *Split view → + Add a channel* in the sidebar adds a tile. Each tile has **✎** (change that channel) and **✕** (take it off the screen); with one channel left the room is back to normal. In the Guide, clicking a channel replaces the tile you're listening to.
- **Everyone:** click a channel in the sidebar list or its label on the picture to hear it, or press **1–4** (this also works with the video fullscreen). The choice is per viewer and remembered for that room.
- **Layouts (host):** the *Layout* buttons under the channel list arrange the tiles. Everyone sees the layout the host picks.
  - **Grid** (the default): equal tiles. 2 = side by side, 3 = two on top and one below, 4 = 2×2.
  - **One large, the rest small:** the main channel takes 80% of the width, the others sit in a column beside it.
  - **Picture in picture:** the main channel fills the screen, the others are small windows along the bottom right.
  - **One above the other:** two equal tiles stacked (2 channels only).
  - The **main** channel is the first in the list; **⤢** on another channel makes that one the main. Adding a third channel to a stacked room goes back to the grid.
- **Turn it off or cap it:** *Settings → Live TV · capacity & playback → Live TV split view* (`LIVETV_SPLIT_MAX`): *Off*, or up to 2, 3 or 4 channels. It applies at once; rooms already split keep their channels (they can still remove tiles).
- **Tuners:** each tile holds a tuner, and counts against `LIVETV_MAX_ROOMS` (see below), which also caps how many tiles one room can have. A room with 3 tiles leaves one tuner free on a 4-tuner box.
- **Any change re-records the picture.** Adding, changing or removing a tile, changing the layout or swapping the main channel shows the tuning screen for roughly 10–15 seconds.
  - **Changing** a tile's channel, the layout or the main channel keeps the recording, so the room can still rewind to before the change (the picture shows what was recorded then; the labels show the current channels and layout).
  - **Adding or removing** a tile starts a fresh recording, so the room can't rewind past it.
- **Always-on rooms** can be pinned to several channels and open in split view; see [Always-On Rooms](Always-On-Rooms).
- **Needs the HDHomeRun source.** It isn't offered with `LIVETV_SOURCE=plex`.
- **Every channel needs sound.** A channel without an audio stream can't be added (*"Channel 7.1 has no audio, so it can't be shown in split view"*).
- **Encoding:** the whole picture is **one** encode, so the encoder cost is close to one channel's. Each extra channel adds the cheaper work of decoding and deinterlacing it.

## Requirements

- An HDHomeRun on your LAN, reachable from the container.
- A Plex server with that tuner set up as a DVR (this is where the guide data comes from).
- Enough CPU (or a supported GPU) to encode — see below.
- Disk space for the recordings.

## Turn it on

In `.env`:

```env
ROOM_TYPE_LIVETV=true
HDHR_IP=192.168.1.115            # your tuner's LAN address
HDHR_PORT=5004                   # default
LIVETV_PLEX_HOST=http://192.168.1.225:32400   # the Plex server with the DVR/guide
# LIVETV_PLEX_TOKEN=             # only if different from PLEX_TOKEN
```

Restart (`docker compose up -d --force-recreate` — a plain restart does **not** re-read `.env`).

If `HDHR_IP` is unset, or `LIVETV_SOURCE=plex`, Playdarr falls back to tuning through Plex's own DVR. That path is less reliable (Plex live sessions can expire unpredictably) and is kept only as a fallback.

## Limiting how many rooms stream: `LIVETV_MAX_ROOMS`

`LIVETV_MAX_ROOMS` is the most Live TV **channels** that can be streaming at the same time, across all rooms. **The default is 2.** A room normally streams one channel; a room in split view streams one per channel on screen. Set it in `.env` (and recreate the container) to match your hardware:

```env
LIVETV_MAX_ROOMS=3
```

- **What counts:** a Live TV room uses its tuners while it is **recording or tuning**. A room that is merely open, such as an empty [always-on room](Always-On-Rooms) or a Live TV room nobody has picked a channel in yet, costs nothing and doesn't count.
- **When it's full:** starting another Live TV room is refused with *"Live TV is full right now (2 of 2 tuners in use). Try again when one ends."* In an always-on room, the host who tries to tune a channel gets the same message. Changing channel inside a room that's already streaming is always allowed, since it swaps one channel for another. Adding a split-view tile needs a free tuner (*"Not enough Live TV tuners free for 3 channels"*).
- **Seamless or not:** when there are enough tuners for the old and new channels at once, a channel change keeps the old one playing until the new one is ready. Otherwise (usually in split view) the old recording stops first and the room shows the tuning screen for a few seconds.
- **Other room types** (movies, TV, YouTube) are unaffected.
- **In the lobby**, the *Live TV · on now* row shows how many tuners are in use ("1 of 2 tuners in use"), and its cards are greyed out and disabled while it's full. People can still join Live TV rooms that are already open.
- **Pick a sensible number:** at most your tuner count (a 4-tuner HDHomeRun means 4), and fewer if your CPU can't encode that many at once. See the capacity table below.

## Pause cooldown: `LIVETV_PAUSE_COOLDOWN_SEC`

Pausing and resuming over and over disrupts a Live TV stream, so Playdarr enforces a gap between pauses: **by default, 10 seconds** after one pause, the next pause is refused. The host's player undoes it immediately and shows *"You can pause again in 9s"*; the room carries on playing and nobody else sees a thing. Resuming is never blocked, and the first pause is instant.

- Set it in `.env` or under **Admin → Settings → Live TV pause cooldown**. `0` turns it off, and the maximum is 120 seconds. It applies immediately.
- It applies to **Live TV rooms only**. Movie, TV and YouTube rooms can be paused as often as people like.
- It's enforced on the server, so it can't be bypassed, and a fresh channel tune starts with a clean slate.

## Capacity planning

| Resource | What to expect |
|---|---|
| **Tuners** | **Each channel on screen occupies one tuner** while the room streams it: one per normal room, one per tile in [split view](#split-view-several-channels-in-one-room). A 4-tuner HDHomeRun supports four channels at once |
| **CPU (software)** | About one core per room for a 1080i channel at the default `veryfast` preset |
| **Disk** | Roughly **3–4 GB per room-hour** at the default bitrate. Recordings are deleted when the room closes and wiped when the server starts |
| **Bandwidth** | Viewers each pull the transcoded stream from Playdarr, not from the tuner |

Size the Docker volume for your busiest case (rooms × 4 GB).

## Buffer and sync

- `LIVETV_BUFFER_SEC` (default `10`, range `4`–`60`) is how far **behind live** a room plays. Because the player can only buffer what's been recorded, this *is* the buffer.
- **Raise it** if viewers see occasional stutters: more safety margin, a bit more delay from the broadcast, a slightly longer start-up.
- Sync is **host-driven**: the host's playback position is the reference; guests nudge their playback speed by a few percent to stay within about half a second.

## Picture quality

| Setting | Effect |
|---|---|
| `LIVETV_UPSCALE=720` (or `1080`) | Scales channels *shorter* than that (e.g. 480i SD) up to it with Lanczos, then a light sharpen. HD channels are untouched. Uses some CPU, mainly on SD channels |
| `LIVETV_SHARPEN=0.5` | Sharpen strength with upscaling (`0` = off) |
| `LIVETV_MAX_BITRATE` | Peak video bitrate (default `8M`) |
| `LIVETV_X264_PRESET` | CPU speed/quality (default `veryfast`; slower = nicer but heavier) |

Upscaling can't add detail that wasn't broadcast. If the picture is noisy or blocky, the fix is usually the **antenna**: check the tuner's own status page for signal strength and quality.

## Hardware encoding (Intel or AMD iGPU)

Moves the heavy H.264 encode from the CPU to the GPU. **Linux hosts only.** The deinterlace stays on the CPU.

1. Make sure the host has the GPU driver loaded and `/dev/dri/renderD128` (or similar) exists: `ls -l /dev/dri`.
2. In `.env`: `LIVETV_HWACCEL=vaapi` (aliases `intel` / `amd` also work).
3. Start with the override file so the device is passed into the container:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up --build -d
   ```
4. Verify:
   ```bash
   docker exec playdarr vainfo                  # should list H.264 encode (EncSlice) entries
   docker compose logs | grep -E "VAAPI|enc="   # shows `enc=vaapi` after you tune a channel
   ```

Notes:

- With several GPUs, set `LIVETV_VAAPI_DEVICE=/dev/dri/renderD128` to pick one. Otherwise the first Intel or AMD device is used (NVIDIA cards are skipped; VAAPI can't use them).
- If the GPU is missing or fails twice in a row with no output, Playdarr **logs a warning and falls back to software x264** automatically.
- GPU encodes can look a touch softer at the same bitrate. Raise `LIVETV_VAAPI_BITRATE` (default `6M`) if you see blockiness.
- NVIDIA/other encoders: use `LIVETV_VIDEO_ARGS`, e.g. `-c:v h264_nvenc -preset p4 -b:v 6M`, and pass the GPU to Docker your own way. Only video-encoder options with one value each are accepted; if yours is refused, the log says `[HDHR] Ignoring LIVETV_VIDEO_ARGS: …` and names the option.
- Tested with an Intel iGPU (iHD driver) in a Proxmox LXC. AMD is wired the same way but has not been tested.

### Proxmox LXC

The LXC shares the Proxmox host's kernel, so install nothing GPU-related inside it. You only pass the device through:

1. On the Proxmox host, confirm `/dev/dri` exists, and note the `render` group ID (commonly 104).
2. In the LXC's **Resources → Add → Device Passthrough**, add `/dev/dri/renderD128` with the container's `render` GID. Or edit `/etc/pve/lxc/<ID>.conf`: `dev0: /dev/dri/renderD128,gid=104`.
3. Docker inside the LXC needs **nesting** (and usually `keyctl`) enabled in the LXC's options.
4. Restart the LXC, then follow the steps above. The Playdarr container runs as root, so no extra group setup is needed in the compose file.

## Troubleshooting Live TV

| Symptom | Likely cause / fix |
|---|---|
| "Live TV is full right now" | You've reached `LIVETV_MAX_ROOMS` (default 2), which counts channels (one per split-view tile). Wait for a room to end, or raise it (up to your tuner count and what your CPU/GPU can encode) and recreate the container |
| No *+ Add a channel* in split view | Split view is off or capped (`LIVETV_SPLIT_MAX`), `LIVETV_MAX_ROOMS` is 1, or `LIVETV_SOURCE=plex` |
| Split-view tile shows the wrong channel after rewinding | Expected: rewound past a tile change, the picture shows what was recorded then, while the label shows the current channel |
| No Live TV option in the lobby | `ROOM_TYPE_LIVETV=true` not set, or you didn't recreate the container after editing `.env` |
| Channel list empty / no program titles | Plex guide unreachable. Check `LIVETV_PLEX_HOST` and token; the Plex DVR must have channels |
| Stuck on "Tuning…" then fails | Tuner busy (all tuners in use) or `HDHR_IP` unreachable from the container |
| Frequent stutters | Raise `LIVETV_BUFFER_SEC`; check CPU use; try GPU encoding |
| Choppy at 100% CPU | Too many simultaneous rooms for the CPU — use VAAPI or fewer rooms |
| Blocky or dropping out | Weak signal — check the tuner's status page / antenna |
| `enc=x264` when you expect VAAPI | Device not passed through, or the fallback kicked in — see `docker compose logs | grep HDHR` |
