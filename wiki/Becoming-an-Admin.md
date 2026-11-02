# Becoming an Admin

Playdarr has **one kind of admin: the owner of the Plex server it's connected to.** There is no admin password, no user table to edit and no environment variable to set.

## How it works

1. At sign-in, Playdarr asks Plex for the list of servers the signing-in account can access (`plex.tv` resources).
2. It finds the entry matching *your* server (by the server's unique machine identifier, read from `PLEX_URL`).
3. If Plex marks that entry as `owned`, the session is flagged as admin.

The flag is stored **in the server-side session**, never in anything the browser can change. Every admin action (`/admin`, `/api/admin/*`, closing rooms, kicking viewers, cancelling anyone's schedule) is checked against it again on the server.

## What you get

- An **admin** badge by your name and an **Admin** button in the lobby.
- The [Admin Panel](Admin-Panel) at `/admin`.
- In any room you've joined: kick buttons on every viewer (even when you're not the host) and a *Close room (admin)* button.
- In the lobby: a viewer list with Kick buttons and *Close room* on every room card, and *Cancel* on every scheduled night.

Details of what you can and can't do to others are in [Moderation](Moderation).

## You don't see the admin controls?

Work down this list:

1. **Sign out and back in.** The flag is set only at sign-in. Sessions created before you upgraded, or before you became the owner, don't have it. This is by far the most common cause.
2. **Check you used the owning account.** Friends who have access to your server are not admins, and neither is a managed user in your Plex Home — only the account that owns the server.
3. **Check the logs** right after signing in:
   ```bash
   docker compose logs | grep -E "server owner|\[Auth\]"
   ```
   A healthy admin sign-in prints `signed in as server owner (admin)`.
4. **Wrong server?** If `PLEX_URL` points at a *different* Plex server from the one your account owns, you'll get in as a normal user (or be refused). Confirm the URL.
5. **Hard-refresh** (Ctrl+F5) in case the browser cached an older script.

## Can there be more than one admin?

Not today: admin is tied to Plex ownership. If you want trusted friends to moderate rooms, make them **host** of that room: a host can already kick viewers and control playback in their own room (they can't kick the owner). Ask if you'd like a configurable admin list added.

## Can an admin be locked out or kicked?

No. Nobody can kick the owner out of a room, and the owner can always close any room.
