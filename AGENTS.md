# AGENTS.md

Instructions for AI assistants and coding agents working with this repository.

## Installing or setting up Playdarr

If the user wants to **install, configure, run or self-host Playdarr**, follow **[AIPROMPT_SETUP.md](AIPROMPT_SETUP.md)**. It's a step-by-step guide written for you: what to ask the user, how to fill in `.env`, how to start and verify the server, and the optional internet-access and Live TV steps.

## Changing the code

If you're working **on the code**, read **[CLAUDE.md](CLAUDE.md)**. It has the commands, the architecture notes (sync model, Live TV DVR, auth, the Plex HLS proxy) and the project's conventions. In short:

- Node.js + Express + Socket.io, vanilla JS frontend, all styling in `src/public/css/app.css`.
- `npm install`, then `npm run dev` (needs a `.env`; copy `.env.example`). Tests: `npm test`.
- When you change behaviour the Admin Guide describes (settings, env vars, admin controls, webhooks, data files), update the matching page in `wiki/` and, for setup-related changes, `AIPROMPT_SETUP.md` in the same change.
- Never commit `.env` or put secrets (Plex token, session secret, API keys) in code or docs.
