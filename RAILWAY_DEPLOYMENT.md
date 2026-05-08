# Railway Deployment

This repo runs as a normal Node.js web service on Railway. The server in `server.js` serves the static website, keeps the clean page routes working, and mounts the API handlers under `/api`.

## Local Run

```bash
npm start
```

Open `http://localhost:3000`.

## Railway Service Settings

Create one Railway service from this GitHub repo.

- Build command: leave empty / auto-detect
- Start command: `npm start`
- Runtime: Node.js 20+

Railway provides `PORT` automatically. The app reads `process.env.PORT`, so no manual port setting is needed.

## Required Environment Variables

Copy these from the current production environment:

```txt
AUTH_SECRET
ROBLOX_OAUTH_CLIENT_ID
ROBLOX_OAUTH_CLIENT_SECRET
ROBLOX_OPEN_CLOUD_API_KEY
DATABASE_URL
```

`DATABASE_URL` is provided by Railway Postgres when the Postgres service is referenced from the web service.

Recommended:

```txt
NODE_ENV=production
ROBLOX_GROUP_ID=5545660
ROBLOX_OAUTH_REDIRECT_URI=https://your-railway-or-custom-domain/api/auth/callback
```

Non-secret platform preferences, such as the OpenAI model name, are managed from `/admin/tools` rather than Railway variables.

## Roblox OAuth

In the Roblox OAuth app settings, add the Railway callback URL:

```txt
https://your-railway-or-custom-domain/api/auth/callback
```

When the custom domain is connected, update both Roblox and Railway to use the custom-domain callback.

## Routes

The server keeps these clean routes working:

- `/privacy`
- `/terms`
- `/admin`
- `/admin/tools`
- `/admin/discord-bot`
- `/admin/tools/copy-monetization`
- `/admin/tools/list-monetization-ids`
- `/admin/tools/sync-game-description`
- `/admin/tools/sync-live-configs`
- `/admin/tools/game-configuration`

It also redirects the old `.html` URLs to the clean routes.

## Future Bot Service

Run the Discord bot as a second Railway service from this same GitHub repo.

- Start command: `npm run start:bot`
- Required variables:
  - `DATABASE_URL` as a reference to Railway Postgres
  - `DISCORD_BOT_TOKEN`
  - `ROBLOX_OPEN_CLOUD_API_KEY` if leaderboard role sync is enabled
  - `BLOXLINK_API_KEY` if leaderboard role sync is enabled

The website dashboard at `/admin/discord-bot` sets the desired bot state in Postgres. The bot service reads that state and connects or disconnects from Discord.

For the leaderboard role sync, the Roblox Open Cloud key must include `universe.ordered-data-store.scope.entry:read`. The dashboard stores the OrderedDataStore name, scope, key prefix, top count, and sync interval; the bot creates a `Leaderboard Player` role automatically unless one already exists.
