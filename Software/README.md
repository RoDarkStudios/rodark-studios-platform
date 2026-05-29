# RoDark Studios Website

Full-stack website and internal admin platform for RoDark Studios.

## Runtime

- Hosting: Railway
- Web runtime: Node.js HTTP server (`server.js`)
- Bot runtime: separate Railway service (`npm run start:bot`)
- Database: Railway Postgres
- Auth: Roblox OAuth 2.0

## Local Development

From the repository root:

```bash
cd Software
npm install
npm start
```

The app listens on `http://localhost:3000` unless `PORT` is set.

To run the Discord bot worker locally:

```bash
cd Software
npm run start:bot
```

## Required Environment Variables

```txt
AUTH_SECRET
ROBLOX_OAUTH_CLIENT_ID
ROBLOX_OAUTH_CLIENT_SECRET
ROBLOX_OPEN_CLOUD_API_KEY
DATABASE_URL
```

Optional:

```txt
ROBLOX_GROUP_ID
ROBLOX_OAUTH_REDIRECT_URI
ROBLOX_OAUTH_SCOPES
ROBLOX_OAUTH_BASE_URL
```

Required for the Discord bot worker:

```txt
DISCORD_BOT_TOKEN
DATABASE_URL
OPENAI_API_KEY
```

Optional for the Discord bot worker:

```txt
DISCORD_BOT_POLL_INTERVAL_MS
OPENAI_TICKET_REVIEW_MODEL
OPENAI_TICKET_REVIEW_REASONING_EFFORT
OPENAI_TICKET_REVIEW_TIMEOUT_MS
BLOXLINK_LOOKUPS_PER_SYNC
BLOXLINK_LOOKUP_DELAY_MS
BLOXLINK_RATE_LIMIT_BACKOFF_MS
```

Required for leaderboard role sync when enabled:

```txt
ROBLOX_OPEN_CLOUD_API_KEY
BLOXLINK_API_KEY
```

## Discord Bot Notes

- The bot also supports startup channel sync from `/admin/discord-bot`. Configure the fixed channel IDs for `rules`, `info`, `roles`, `staff-info`, and `game-test-info`, then reconnect or restart the bot to resync those channels.
- Ticket requests are reviewed with OpenAI before a private channel is created. The default model is `gpt-5.5` with `OPENAI_TICKET_REVIEW_REASONING_EFFORT=medium`; set `OPENAI_TICKET_REVIEW_MODEL` on the bot worker to override it.
- Leaderboard role sync needs `ROBLOX_OPEN_CLOUD_API_KEY` and `BLOXLINK_API_KEY` on the bot service when enabled.
- On startup, the bot ensures required custom emojis exist using local files under `bot/assets/discord/emojis` and uses banner images from `bot/assets/discord/channel-images`.

## Database

The current schema lives in `railway/postgres-schema.sql`.

## Key Routes

- `/`
- `/privacy`
- `/terms`
- `/admin`
- `/admin/tools`
- `/admin/tools/game-configuration`
- `/admin/discord-bot`
- `/api/health`
