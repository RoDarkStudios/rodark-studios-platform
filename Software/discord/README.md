# Discord server configuration

`server.json` defines the RoDark Studios server. Edit this file, commit and push, wait for both Railway services to update, then open **Admin → Discord Bot → Status → Deploy**. This feature has one button. The bot checks and applies changes automatically; the page only shows progress or errors. Pushing code does not apply the new layout to Discord.

## First deployment and later updates

The first deployment deliberately replaces existing channels and categories. Their messages, forum posts and open ticket channels are deleted. It removes Bloxlink, unlisted editable roles and native AutoMod rules; the existing contextual AI moderation remains enabled. Earned XP, the honeypot ban count and assignments to retained roles are preserved.

Later deployments match stable `key` values to Discord IDs saved in Postgres. Renaming a channel, moving it, editing permissions or updating forum tags preserves that channel and its history. Keep keys unchanged when renaming things. Removing an entry deletes its channel and history; changing its channel type replaces it. Reintroducing a removed key creates a new channel. Forum threads and registered open tickets under the configured Tickets category are dynamic content, so ordinary deployments preserve them.

The Owner role, the bot's own roles and Discord-managed roles cannot be wiped as ordinary infrastructure. Before the first deployment, keep exactly one **Owner** role with Administrator above the bot, and give the bot Administrator. All other roles the bot must edit or remove, including Bloxlink's highest role, must be below it. Deployment stops before writes if these checks fail. Discord assigns the native Server Booster role automatically; the blueprint styles it if it exists.

## Layout and permissions

The current definition creates 10 categories and 42 channels. Categories use plain display names such as `Animal Tag` and `My Coding Company`; their stable keys do not change when renamed. All normal channel names use `emoji・name`. The honeypot retains its existing name and warning-before-opening behaviour. Private staff information and the moderation log are read only for Staff. Tickets remain visible to their opener, Staff, Owners and the bot. Every new ticket pings Staff and Owners. Its panel uses the `help` channel binding; startup information and level-up messages also use their declared channel bindings.

Staff can moderate people, messages and voice chat, but cannot manage the server, roles or channels. Staff do not receive Manage Threads because that permission also permits changing protected forum tags. Instead, `/forum-moderate` lets them lock, reopen or delete a member's post in the declared game forums. It cannot change Fixed, Closed or Implemented tags or moderate an Owner's post. Only Owners can create dev-discussion posts; members can reply.

Content Creators are manually assigned through normal ticket applications and can post in each game's YouTube channel with a six-hour slowmode. Notifications are opt-in roles; Owners mention them manually. Level settings live in `server.json`: leveling is enabled, Embed Links unlocks at Level 5, and level-up announcements do not ping members. Existing milestones (5, 10, 15, 25, 50, 75, 100) and XP are retained. Uploads are disabled in game chat and private-server channels, and allowed in media; link and GIF previews still follow the existing level gate. Plain links can be posted without Embed Links.

Advanced Community Onboarding asks members to select one or more games and optionally notification roles. The selected games populate their channel list, and members can change choices in Channels & Roles. Unselected games remain discoverable in Browse Channels: the selection controls clutter, not confidentiality. Member is assigned by onboarding and when an existing member next chats. The honeypot is never an onboarding destination. New questions include generated request IDs as required by Discord; returned question and option IDs are saved and reused on later deployments, including renames.

## Deployment, drift and recovery

The website authenticates studio owners using the existing Roblox group rank check (254 or higher). Requests are restricted to the same website origin. It queues work in Postgres; the bot alone calls Discord using its existing token. No new environment variables are required. The new database tables are created automatically and are included in `railway/postgres-schema.sql`.

Deploy queues a durable job. The bot first reads Discord, validates permissions and records the configuration version and live state, then automatically queues application. This transition is atomic and continues after the browser closes. The bot rechecks live state before writes and rejects stale or expired checks. A Postgres advisory lock serializes bot setup and deployment across replicas. During application, layout maintenance, tickets and AI moderation pause; new resource IDs are checkpointed immediately. Bot messages and integrations are connected to their new IDs before deployment is verified and activated.

Discord has no atomic transaction or rollback for a server rebuild. If application fails or the bot restarts midway, the dashboard reports it and maintenance remains paused. Click Deploy again to check and apply the remaining changes. Saved IDs allow recovery without recreating already-created channels. Keep the Postgres database: restoring or deleting infrastructure state can lose the ID mapping and incorrectly request a first rebuild.

Before removing old channels, deployment switches the required Community channel assignments to the new rules, staff information and moderation log channels, then reads the guild back to confirm the switch. Each assignment request includes `COMMUNITY` and preserves the guild's freshly read feature list: the live API was observed returning success but ignoring rules/updates channel assignments when `features` was omitted, even with Community already enabled. Unconfirmed assignments report the expected and actual IDs. Discord's protected-channel error (50074) is retried with bounded delays. Persistent failures stop the deployment and identify the channel; they are never counted as successful deletions. Rules, info, roles and the ticket panel are populated after cleanup, so a cleanup failure leaves these pending until the next successful Deploy.

Gateway events trigger read-only drift checks, with a periodic refresh for missed events. Drift compares against the last successfully deployed definition, not unpublished edits. Extra channels or editable roles created manually are removed on the next deployment. Actual repair still requires Deploy.

## Implementation and checks

- `bot/server-blueprint.js`: validation, permission compilation, stable references and planning.
- `bot/server-infrastructure.js`: Discord snapshots, ordered application, verification and drift.
- `api/_lib/discord-infrastructure-store.js`: durable state, job queue and deployment lock.
- `api/admin/discord-infrastructure.js`: owner-only website endpoint.
- `discord-infrastructure.js`: the Deploy button and progress/error status.

Run `node --test bot/*.test.js` from `Software`. Tests use fake Discord calls and an isolated Postgres-compatible database; they do not modify the real server.

Discord references: [Guild and onboarding API](https://docs.discord.com/developers/resources/guild), [channels and forum tags](https://docs.discord.com/developers/resources/channel), [permissions and role hierarchy](https://docs.discord.com/developers/topics/permissions), [forum post permissions](https://docs.discord.com/developers/topics/threads), [Community Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ).

The website has only Status (Connect/Disconnect and Deploy) and Transcripts. Server ID, channels, ticket helpers and level behaviour are repository configuration. Announcements are posted manually in Discord.
