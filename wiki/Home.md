# Playdarr Admin Guide

Playdarr is a self-hosted watch-party app for your Plex server: synced movies, TV, YouTube and live TV, with chat (GIFs, images, replies and reactions), guest invite links, rich link previews, recurring watch nights and swipe-to-vote movie picking.

This wiki is for the **person who runs the server**. It covers setting Playdarr up, using the admin panel, keeping rooms friendly, wiring up Discord notifications, and looking after the data.

> **Who is the admin?** Whoever **owns the Plex server** Playdarr is connected to. There's no password or setting — sign in with the owning Plex account and the admin controls appear. See [Becoming an Admin](Becoming-an-Admin).

## Start here

| If you want to… | Read |
|---|---|
| Get a fresh install running and tested | [Admin Quick Start](Admin-Quick-Start) |
| Understand (or fix) who counts as admin | [Becoming an Admin](Becoming-an-Admin) |
| Learn what's on the `/admin` page | [Admin Panel](Admin-Panel) |
| Change configuration from the browser | [Settings Page](Settings-Page) |
| Post reminders and invite links to Discord | [Webhooks and Notifications](Webhooks-and-Notifications) |
| Kick, mute or rename someone, close a room, delete messages, filter offensive words | [Moderation](Moderation) |
| Turn on GIFs, choose who can post images | [Settings Page](Settings-Page) · [Configuration Reference](Configuration-Reference) |
| Set up weekly movie nights | [Scheduling and Recurring Nights](Scheduling-and-Recurring-Nights) |
| Keep a room (or a Live TV channel) open all the time | [Always-On Rooms](Always-On-Rooms) |
| Run Live TV from an HDHomeRun | [Live TV Administration](Live-TV-Administration) |
| Show several Live TV channels in one room | [Split view](Live-TV-Administration#split-view-several-channels-in-one-room) |
| Look up an environment variable | [Configuration Reference](Configuration-Reference) |
| Back up, restore or update | [Data, Backups and Updates](Data-Backups-and-Updates) |
| Lock things down | [Security Notes](Security-Notes) |
| Work out why something isn't working | [Troubleshooting](Troubleshooting) |

## How Playdarr fits together (30-second version)

- **Playdarr** is one Node.js container. It proxies video from your Plex server (so Plex tokens never reach browsers) and keeps every viewer in a room in sync.
- **Plex users** sign in with Plex and can create rooms. **Guests** join through an invite link with just a display name.
- **Rooms live in memory.** Restarting the container closes them, except **always-on rooms**, which are recreated. Schedules, webhooks, the people list, settings and always-on rooms are saved to disk and survive restarts. Chat (and any images posted in it) belongs to its room and goes with it.
- **Live TV** (optional) comes straight from an HDHomeRun tuner through ffmpeg into a per-room on-disk recording; Plex supplies only the channel guide. A room can split the screen between up to 4 channels, with each viewer choosing which one they hear.

## Conventions used in this guide

- `code` is a value you type or a file name. Commands are written for a shell in the project folder.
- *Italic* names are buttons or labels in the app.
- Notes marked **Heads-up** are things that commonly catch people out.
