# Discord server configuration

`server.json` defines the RoDark Studios server. Edit this file, commit and push, wait for both Railway services to update, then open **Admin → Discord Bot → Server Layout → Preview changes → Deploy**. Pushing code does not apply the new layout to Discord.

## First deployment and later updates

The first deployment deliberately replaces existing channels and categories. Their messages, forum posts and open ticket channels are deleted. It removes Bloxlink, unlisted editable roles and native AutoMod rules; the existing contextual AI moderation remains enabled. Earned XP, the honeypot ban count and assignments to retained roles are preserved.

Later deployments match stable `key` values to Discord IDs saved in Postgres. Renaming a channel, moving it, editing permissions or updating forum tags preserves that channel and its history. Keep keys unchanged when renaming things. Removing an entry deletes its channel and history; changing its channel type replaces it. Reintroducing a removed key creates a new channel. Forum threads and registered open tickets under the configured Tickets category are dynamic content, so ordinary deployments preserve them.

The Owner role, the bot's own roles and Discord-managed roles cannot be wiped as ordinary infrastructure. Before the first deployment, keep exactly one **Owner** role with Administrator above the bot, and give the bot Administrator. All other roles the bot must edit or remove, including Bloxlink's highest role, must be below it. Preview reports hierarchy blockers. Discord assigns the native Server Booster role automatically; the blueprint styles it if it exists.

## Layout and permissions

The current definition creates 10 categories and 42 channels. All normal channel names use `emoji・name`. The honeypot retains its existing name and warning-before-opening behaviour. Private staff information and the moderation log are read only for Staff. Tickets remain visible to their opener, Staff, Owners and the bot.

Staff can moderate people, messages and voice chat, but cannot manage the server, roles or channels. Staff do not receive Manage Threads because that permission also permits changing protected forum tags. Instead, `/forum-moderate` lets them lock, reopen or delete a member's post in the declared game forums. It cannot change Fixed, Closed or Implemented tags or moderate an Owner's post. Only Owners can create dev-discussion posts; members can reply.

Content Creators are manually assigned through normal ticket applications and can post in each game's YouTube channel with a six-hour slowmode. Notifications are opt-in roles; Owners mention them manually. Existing level milestones (5, 10, 15, 25, 50, 75, 100) and the configured Embed Links unlock level are retained. Uploads are disabled in game chat and private-server channels, and allowed in media; link and GIF previews still follow the existing level gate. Plain links can be posted without Embed Links.

Advanced Community Onboarding asks members to select one or more games and optionally notification roles. The selected games populate their channel list, and members can change choices in Channels & Roles. Unselected games remain discoverable in Browse Channels: the selection controls clutter, not confidentiality. Member is assigned by onboarding and when an existing member next chats. The honeypot is never an onboarding destination.

## Deployment, drift and recovery

The website authenticates studio owners using the existing Roblox group rank check (254 or higher). Requests are restricted to the same website origin. It queues work in Postgres; the bot alone calls Discord using its existing token. No new environment variables are required. The new database tables are created automatically and are included in `railway/postgres-schema.sql`.

Preview only reads Discord. It lists operations and blockers, captures the configuration version and live state, and expires after 15 minutes. Deploy rejects stale previews. A Postgres advisory lock serializes bot setup and deployment across replicas. During application, layout maintenance, tickets and AI moderation pause; new resource IDs are checkpointed immediately. Bot messages and integrations are connected to their new IDs before the deployment is verified and activated.

Discord has no atomic transaction or rollback for a server rebuild. If an operation fails or the bot restarts, the dashboard reports it and maintenance remains paused. Generate a fresh preview and deploy the remaining changes. Saved IDs allow recovery without recreating already-created channels. Keep the Postgres database: restoring or deleting infrastructure state can lose the ID mapping and incorrectly request a first rebuild.

Gateway events trigger read-only drift checks, with a periodic refresh for missed events. Drift compares against the last successfully deployed definition, not unpublished edits. Extra channels or editable roles created manually appear as removals in the next preview. Actual repair still requires Deploy.

## Implementation and checks

- `bot/server-blueprint.js`: validation, permission compilation, stable references and planning.
- `bot/server-infrastructure.js`: Discord snapshots, ordered application, verification and drift.
- `api/_lib/discord-infrastructure-store.js`: durable state, job queue and deployment lock.
- `api/admin/discord-infrastructure.js`: owner-only website endpoint.
- `discord-infrastructure.js`: preview, deployment progress and configuration viewer.

Run `node --test bot/*.test.js` from `Software`. Tests use fake Discord calls and an isolated Postgres-compatible database; they do not modify the real server.

Discord references: [Guild and onboarding API](https://docs.discord.com/developers/resources/guild), [channels and forum tags](https://docs.discord.com/developers/resources/channel), [permissions and role hierarchy](https://docs.discord.com/developers/topics/permissions), [forum post permissions](https://docs.discord.com/developers/topics/threads), [Community Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ).
