# Moderation

How to keep rooms friendly. As the owner you can act from the **lobby**, from **inside a room**, or from the **[Admin Panel](Admin-Panel)** — they all do the same things.

## The short version

| I want to… | Do this |
|---|---|
| Remove a disruptive viewer | *Kick* them (lobby room card, in-room viewer list, or ✕ on their chip in Admin). They're also **blocked from rejoining that room** |
| Shut a room down | *Close room* (lobby card, in-room button, or Admin). Everyone is sent back to the lobby |
| Fix an inappropriate nickname | Admin → **People** → *Reset nickname* |
| Cancel someone's scheduled night | *Cancel* on the card (or *Cancel series* for a recurring one) |
| Stop a recurring night happening once | *Skip next* |

## Kicking and blocking

- **Where:** the lobby shows each room's viewers with a *Kick* button. Inside a room, every viewer has a *Kick* button (hosts see them too). In Admin, click the ✕ on a viewer chip.
- **What happens:** the person sees "You have been removed from this room by the server owner" and is sent to the lobby.
- **The block:** a kick by the **owner** also stops that account rejoining *that room*. If they try, they get "You have been removed from this room by the server owner". A kick by an ordinary **host** removes the person but does **not** block them from rejoining.
- **The block lasts until the room closes.** It's kept in memory, so closing the room or restarting the server clears it. Blocks are per room, not global.

### Guests

A guest's identity is created fresh from the invite link. If you kick and block a guest, they can get back in by opening the invite link again (which makes a new identity). To keep a determined guest out, **close the room** and make a new one, or send fresh invites to the people you trust.

### What can't be kicked

- **The owner.** Nobody — host or otherwise — can remove you from a room.
- **The room's host,** by the owner's *Kick*. You'll be told to close the room instead. A host who is misbehaving is handled by closing the room.

## Closing rooms

- *Close room* ends the room immediately, tells everyone "Closed by the server owner", stops any Live TV recording for it and deletes its invite.
- A **scheduled** room that has already opened is closed the same way. The *schedule* itself (the next occurrence of a recurring night) is not affected — use *Cancel series* for that.
- Rooms also close on their own 30 seconds after the host leaves with nobody to take over. If viewers remain, the room moves to another viewer instead, preferring Plex users over guests.

**Always-on rooms** are the exception: *Close room* (shown as *Eject everyone*) sends everyone out and resets the room, which stays open and listed. To get rid of one for good, use *Remove* under Admin → Always-on rooms ([Always-On Rooms](Always-On-Rooms)).

## Hosts' own controls

Anyone hosting a room can:

- kick viewers (without blocking),
- hand the host role to someone else,
- **force a resync**: the *⟳ Force resync* button under the message box pauses everyone at your position, shows a 2-second countdown, and resumes them all together from the same spot (once per 10 seconds),
- lock playback so only they can control it,
- turn reactions off.

So you rarely need to step in for ordinary disagreements. Keep the owner tools for when you need them.

## Nicknames

People can set their own display name from the lobby (the ✎ button). Playdarr **remembers** it against their Plex account in `users.json`, so it survives signing out, expiring sessions and restarts, and it's what other people see in rooms.

- *Admin → People* lists every Plex account with its nickname.
- *Reset nickname* clears it. The person is back to their Plex name on their **next page load** and can choose another nickname.
- It doesn't force-rename them mid-session or stop them choosing the same inappropriate name again; for repeat offenders, see *Kick* and block above.
- Guests choose a name each time they join and aren't remembered.

## Good practice

- Keep **webhook** channels read-only so notifications can't be talked over.
- Have regulars **host** their own rooms; hosts are the first line of moderation.
- Treat invite links as shared secrets: anyone with the link can join as a guest. Closing the room invalidates it.
