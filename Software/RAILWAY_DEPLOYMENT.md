# Railway Deployment

This repo stores company documents and software in separate top-level folders. Railway should run the Node.js services from the `Software` directory. The server in `server.js` serves the static website, keeps the clean page routes working, and mounts the API handlers under `/api`.

## Local Run

```bash
cd Software
npm start
```

Open `http://localhost:3000`.

## Railway Service Settings

Create one Railway service from this GitHub repo.

- Root directory: `Software`
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

Set `OPENAI_API_KEY` on the Discord bot Railway service for contextual moderation. The model is fixed to `gpt-5.6-luna` with high reasoning. Optional `DISCORD_MODERATOR_ROLE_IDS`, `DISCORD_MODERATION_LOG_CHANNEL_ID` and `DISCORD_MODERATION_EXCLUDED_CHANNEL_IDS` also belong on that service. See [moderation setup](bot/MODERATION.md). Old ticket AI environment variables are no longer used and can be removed.

`DISCORD_BOT_TOKEN` is also needed on the web service if you want `/admin/discord-bot` to show searchable Discord channel and role pickers instead of manual IDs.

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
- `/admin/consultations`
- `/admin/profit-tracker`
- `/admin/discord-bot`

It also redirects the old `.html` URLs to the clean routes.

## Discord Bot Service

Run the Discord bot as a second Railway service from this same GitHub repo.

- Root directory: `Software`
- Start command: `npm run start:bot`
- Required variables:
  - `DATABASE_URL` as a reference to Railway Postgres
  - `DISCORD_BOT_TOKEN`

The website dashboard at `/admin/discord-bot` sets the desired bot state in Postgres. The bot service reads that state and connects or disconnects from Discord.
