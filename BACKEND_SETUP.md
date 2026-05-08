# Roblox OAuth 2.0 + Railway Setup

This repo uses Roblox OAuth 2.0 as the only login method.

The app is deployed as a normal Node.js service on Railway. `server.js` serves the static website and mounts the existing API handlers. See `RAILWAY_DEPLOYMENT.md` for Railway-specific deployment steps.

## API Endpoints
- `GET /api/auth/login` -> redirects to Roblox authorization
- `GET /api/auth/callback` -> OAuth callback, creates app session cookie
- `GET /api/auth/me` -> returns current signed-in user
- `GET /api/auth/admin` -> resolves Roblox group rank and admin eligibility (`rank >= 254`)
- `POST /api/auth/logout` -> clears session
- `POST /api/admin/roblox-copy-monetization` -> admin sync tool for game passes + developer products + badges
- `POST /api/admin/roblox-list-monetization-items` -> admin listing tool for Development/Test/Production game pass + product IDs/names
  - Also handles:
    - shared game configuration: `operation = game-config:get` / `operation = game-config:save`
    - game description sync: `operation = load` / `operation = save`
    - Roblox Configs sync: `operation = config:load` / `operation = config:sync`
- `GET /api/profile` -> same user profile data from session
- `GET /api/health`

## Required Environment Variables
- `AUTH_SECRET` (long random secret used to sign session/state tokens)
- `ROBLOX_OAUTH_CLIENT_ID`
- `ROBLOX_OAUTH_CLIENT_SECRET`
- `ROBLOX_OPEN_CLOUD_API_KEY` (used by the admin monetization tools and Discord leaderboard role sync)
- `DATABASE_URL` (Railway Postgres connection used to persist shared Production/Test/Development game IDs)
- `DISCORD_BOT_TOKEN` (required by the Discord bot service; also required by the web service for Discord dashboard channel/role lookups)

Optional:
- `ROBLOX_OAUTH_REDIRECT_URI`
  - If not set, app auto-uses `${origin}/api/auth/callback`
- `ROBLOX_OAUTH_SCOPES` (default: `openid profile`)
- `ROBLOX_OAUTH_BASE_URL` (default: `https://apis.roblox.com/oauth`)
- `ROBLOX_GROUP_ID` (default: `5545660`, used for Admin tab visibility)

For `ROBLOX_OPEN_CLOUD_API_KEY`, include these Open Cloud scopes on all source/target universes used by the tool:
- `game-pass:read`
- `game-pass:write`
- `developer-product:read`
- `developer-product:write`
- `legacy-universe.badge:manage-and-spend-robux`
- `legacy-universe.badge:write`
- `legacy-badge:manage`

For description sync, also include:
- `universe.place:write`

For Roblox Configs sync (`InExperienceConfig`), also include:
- `universe:read`
- `universe:write`

For Discord leaderboard role sync, also include:
- `universe.ordered-data-store.scope.entry:read`

Admin sync behavior notes:
- Request body now uses fixed fields: `productionUniverseId` (source), `developmentUniverseId` (target), `testUniverseId` (target).
- Optional: set `operation = estimate` on `POST /api/admin/roblox-copy-monetization` to return an ETA estimate payload without performing any writes.
- Target items are matched by name (case-insensitive), then updated to source name/description/icon.
- If no name match is found for a source game pass/product, the sync reuses one archived target item first (if available) before creating a new one.
- Development/Test target prices are always forced to `1` Robux for game passes and developer products.
- Badges always copy as-is (name/description/enabled/icon).
- Regional pricing for synced/created items is copied from source items.
- The endpoint has a concurrency lock: if another sync is already running for any of the same universes, a `409` is returned.
- Open Cloud currently has no delete endpoints for these resources, so unmatched target items are archived instead of deleted.
- Archived game passes/developer products are normalized to `[ARCHIVED] <item-id>`. They are forced off-sale and assigned a blank icon so they can act as a reusable bank.
- Archived badges are renamed to `[ARCHIVED] <item-id>`, disabled, and assigned a blank icon.
- If Roblox rejects a neutral icon upload, the item is still archived and the sync records a warning (instead of failing the whole item).
- The live config sync tool uses Roblox Configs `InExperienceConfig`, overwrites the current draft in Test/Development, and publishes immediately so changes go live without restarting servers.

## Roblox OAuth App Configuration
In your Roblox OAuth app settings, ensure the redirect URI matches:
- `https://your-domain.com/api/auth/callback` (production)
- `http://localhost:3000/api/auth/callback` (local, if used)

Recommended app links:
- Entry link: `https://your-domain.com/`
- Privacy Policy URL: `https://your-domain.com/privacy`
- Terms of Service URL: `https://your-domain.com/terms`

## Deploy Steps
1. Set environment variables in Railway.
2. Add Railway Postgres and connect `DATABASE_URL` to the web service.
3. Run the Postgres schema in `railway/postgres-schema.sql` if the table has not already been created.
4. Redeploy.
5. Open your site homepage and click `Sign in with Roblox` in the top-right account badge.

## Notes
- Session is stored in HttpOnly cookie: `rd_session`.
- OAuth state is stored in HttpOnly cookie: `rd_oauth_state`.
