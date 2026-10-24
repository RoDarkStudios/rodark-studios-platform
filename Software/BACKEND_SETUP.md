# Roblox OAuth 2.0 + Railway Setup

This repo uses Roblox OAuth 2.0 as the only login method.

The app is deployed as a normal Node.js service on Railway from the `Software` directory. `server.js` serves the static website and mounts the existing API handlers. See `RAILWAY_DEPLOYMENT.md` for Railway-specific deployment steps.

## API Endpoints
- `GET /api/auth/login` -> redirects to Roblox authorization
- `GET /api/auth/callback` -> OAuth callback, creates app session cookie
- `GET /api/auth/me` -> returns current signed-in user
- `GET /api/auth/admin` -> resolves Roblox group rank and admin eligibility (`rank >= 254`)
- `POST /api/auth/logout` -> clears session
- `GET /api/profile` -> same user profile data from session
- `GET /api/health`

## Required Environment Variables
- `AUTH_SECRET` (long random secret used to sign session/state tokens)
- `ROBLOX_OAUTH_CLIENT_ID`
- `ROBLOX_OAUTH_CLIENT_SECRET`
- `DATABASE_URL` (Railway Postgres connection used for shared admin and Discord-bot data)
- `DISCORD_BOT_TOKEN` (required only by the Discord bot worker)

Optional:
- `ROBLOX_OAUTH_REDIRECT_URI`
  - If not set, app auto-uses `${origin}/api/auth/callback`
- `ROBLOX_OAUTH_SCOPES` (default: `openid profile`)
- `ROBLOX_OAUTH_BASE_URL` (default: `https://apis.roblox.com/oauth`)
- `ROBLOX_GROUP_ID` (default: `5545660`, used for Admin tab visibility)

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
3. Run the Postgres schema in `Software/railway/postgres-schema.sql` from the repository root, or `railway/postgres-schema.sql` from inside `Software`, if the table has not already been created.
4. Redeploy.
5. Open your site homepage and click `Sign in with Roblox` in the top-right account badge.

## Notes
- Session is stored in HttpOnly cookie: `rd_session`.
- OAuth state is stored in HttpOnly cookie: `rd_oauth_state`.
