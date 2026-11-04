# Moderation

How to keep rooms friendly. As the owner you can act from the **lobby**, from **inside a room**, or from the **[Admin Panel](Admin-Panel)** — they all do the same things.

## The short version

| I want to… | Do this |
|---|---|
| Remove a disruptive viewer | *Kick* them (lobby room card, in-room viewer list, or ✕ on their chip in Admin). They're also **blocked from rejoining that room** |
| Shut a room down | *Close room* (lobby card, in-room button, or Admin). Everyone is sent back to the lobby |
| Fix an inappropriate name | *Rename* them (hover the in-room viewer list, or Admin → **People**), or *Reset nickname* |
| Quieten someone being a jerk | *Mute* them (hover the viewer list). They can still watch but can't chat until you *Unmute* them or the room closes |
| Remove a message | Hover it in chat → 🗑 (this also deletes an attached image from the server) |
| Stop people posting pictures | Settings → *Chat & moderation* → *Image uploads in chat*: *Plex users only* or *Off* |
| Stop offensive words | On by default: chat masks them (`****`) and names are refused. Tune it in Admin → **Settings** → *Moderation* |
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

- *Admin → People* lists every Plex account with its nickname. *Rename* sets a new nickname; *Reset nickname* clears it back to their Plex name.
- **Renaming inside a room:** hover the viewer list and click *Rename*. The owner can rename anyone (for a Plex user that becomes their nickname everywhere). A **host** can rename **guests** in their own room, but not Plex users.
- Renames and resets apply **straight away** wherever the person is connected, and the room chat gets a line like "✏️ renamed Bob to Robert". People can still change their own nickname later; for repeat offenders, see *Kick* and block above.
- Guests choose a name each time they join and aren't remembered. A guest renamed by a host keeps the new name until they leave.

## Muting and deleting messages

- **Mute:** hover the in-room viewer list and click *Mute*. The person sees "You've been muted in this room", their message box is disabled, and a 🔇 shows next to their name for everyone. They can still watch and react. *Unmute* lets them chat again.
- **Who can mute:** the host (anyone except you, the owner) and you (anyone, including the host). It lasts until the room closes, and survives the person refreshing the page; it's per room, not global.
- **Deleting messages:** hover a message and click 🗑. Everyone can delete their own; the host can delete anyone's except yours; you can delete anyone's. Others see "Removed by *name*" in its place.
- **Pictures in chat:** people can paste, drop or attach images (PNG, JPEG, WebP, GIF up to 8 MB). Unlike GIFs, which Giphy rates, these aren't screened — delete and mute are your tools. Every image is resized and re-saved by the server (which strips hidden data such as phone location), only people in that room can load it, and it's deleted with its message, when the room closes, and on restart. Choose who may post them under Settings → *Chat & moderation*.
- **Reactions on messages** use the same six emojis as the video reactions. A muted person can't react either.
- Chat history (the last 100 messages, so people who join late see the conversation) lives in memory and is gone when the room closes or the server restarts.

## Offensive-word filter

On by default. It uses a built-in English list that also catches look-alike spellings (`sh1t`, `fvck`) while leaving innocent words alone (*Scunthorpe*, *assassin*).

- **Chat:** offending words are replaced with asterisks — "this is ****ing great". The message still goes through.
- **Names:** a guest name, nickname, room name, scheduled night name or rename that contains one is refused with "Please pick a name without offensive words."
- **Settings → Moderation:** turn the filter off, add words of your own (*Also block these words*), or let through words it catches by mistake (*Always allow these words*, e.g. a town called Penistone or someone called Dick). Comma-separated; changes apply immediately. Words are matched by their letters, so punctuation inside a word is ignored.
- Plex account names themselves aren't filtered (people don't choose them here); rename the person if needed.

## Good practice

- Keep **webhook** channels read-only so notifications can't be talked over.
- Have regulars **host** their own rooms; hosts are the first line of moderation.
- Treat invite links as shared secrets: anyone with the link can join as a guest. Closing the room invalidates it.
