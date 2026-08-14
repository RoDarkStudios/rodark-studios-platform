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

Required for paid consultation checkout on the web service:

```txt
STRIPE_SECRET_KEY
```

Recommended for Stripe webhooks:

```txt
STRIPE_WEBHOOK_SECRET
```

Optional consultation checkout settings:

```txt
CONSULTATION_PRICE_CENTS=30000
CONSULTATION_CURRENCY=usd
CONSULTATION_DISCOUNT_OFFERS=friend50=4900,creator79=7900
PUBLIC_SITE_URL=https://rodarkstudios.com
```

`CONSULTATION_DISCOUNT_OFFERS` is optional. Each entry is `offerCode=finalPriceInCents`, separated by commas, semicolons, or new lines. A configured code creates a private link like `/consultation?offer=friend50`; the server applies the discounted final price during Stripe Checkout.

Optional for the Discord bot worker:

```txt
DISCORD_BOT_POLL_INTERVAL_MS
OPENAI_TICKET_REVIEW_MODEL
OPENAI_TICKET_REVIEW_REASONING_EFFORT
OPENAI_TICKET_REVIEW_TIMEOUT_MS
```

## Discord Bot Notes

- The bot also supports startup channel sync from `/admin/discord-bot`. Configure the fixed channel IDs for `rules`, `info`, `roles`, `staff-info`, and `game-test-info`, then reconnect or restart the bot to resync those channels.
- Ticket requests are reviewed with OpenAI before a private channel is created. The default model is `gpt-5.5` with `OPENAI_TICKET_REVIEW_REASONING_EFFORT=medium`; set `OPENAI_TICKET_REVIEW_MODEL` on the bot worker to override it.
- On startup, the bot ensures required custom emojis exist using local files under `bot/assets/discord/emojis` and uses banner images from `bot/assets/discord/channel-images`.

## Database

The current schema lives in `railway/postgres-schema.sql`.

## Key Routes

- `/`
- `/privacy`
- `/terms`
- `/consultation`
- `/consultation/thanks`
- `/admin`
- `/admin/consultations`
- `/admin/profit-tracker`
- `/admin/discord-bot`
- `/api/health`
