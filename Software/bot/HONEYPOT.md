# Anti-spam honeypot

Whenever the worker connects, it creates or reuses `ignore│do-not-type` (the compact spelling of `ignore | do-not-type`) inside an `IGNORE` category near the top of the channel list. It maintains a warning embed and disabled honey-pot button showing successful bans. Setup runs before the other startup features and is checked again every five minutes. No new dashboard configuration is required. The existing Discord server ID scopes this feature; if it is empty, the worker manages each server it belongs to, like its other server features.

The bot requires **Ban Members**, **Manage Channels**, **Manage Roles** (Discord's Manage Permissions), **Manage Messages**, **View Channel**, **Read Message History**, **Send Messages**, **Attach Files**, and **Embed Links**. Give it **Pin Messages** to pin the warning as well. Its highest role must be above every account it needs to ban. Discord prevents banning the server owner and members at or above the bot's highest role; failures appear in the worker logs and dashboard runtime error.

The dedicated channel's permission overwrites are managed by the bot. It explicitly lets everyone view the warning, send messages, upload files and embed links, replacing conflicting role/member overwrites in this channel. The level system's server-wide link-preview gate therefore does not block the trap. Everyone mentions and threads are disabled. Timeout, membership screening and Discord's other server-level restrictions still apply. No permissions in ordinary chat/media channels are changed by the honeypot.

**Every new user or bot message in the armed channel triggers a permanent ban**, including image-only posts, stickers, replies and messages in any thread an administrator creates under it. The bot ignores its own messages and Discord system events. It deletes webhook messages and reports their IDs for integration review; a webhook is not a bannable member. There is no blanket exemption for administrators or other bot accounts below the worker's role. Legitimate users who post accidentally are also banned. Do not use this channel to test the bot with a real member account.

The ban requests deletion of the account's messages from the previous **one hour across the server**, to remove the current spam burst. The counter increases only after a successful ban. PostgreSQL stores the channel/warning IDs and successful ban events, so restarts, recreated channels and warning repairs retain the count. These tables are created automatically. Discord's audit log records the trigger message and channel IDs in the ban reason. Worker logs record success and failures without copying scam content or links.

New channels remain read-only until the warning is posted. Existing warning messages are only reused if they were authored by this bot and have its honeypot marker. Historical posts are not retroactively banned; the worker must be online and the channel armed when the message arrives. A name match is used only during channel setup, never as sufficient proof to ban someone. Run one bot-worker replica to avoid multiple workers racing Discord channel creation and moderation.

## Why near the top?

This is a known defence against accounts that flood writable channels. Some spam scripts start near the top; a bottom-of-list trap may catch them only after they have spammed the rest of the server. The separate `IGNORE` category and explicit warning reduce accidental human use. Sophisticated scripts can skip obvious trap names, so this complements other moderation rather than guaranteeing every scam will be caught.

- [Honeypot positioning recommendations](https://honeypot.riskymh.dev/docs/tips)
- [Honeypot behaviour and accidental-message caveat](https://honeypot.riskymh.dev/docs/faq)
- [Discord permissions and role hierarchy](https://docs.discord.com/developers/topics/permissions)
- [Discord ban and message-deletion API](https://docs.discord.com/developers/resources/guild#create-guild-ban)

Plain URLs require Send Messages; Embed Links controls their previews. Existing AutoMod or third-party moderation rules can block messages before this worker sees them. This feature does not disable those protections: a blocked message never reaches the trap and cannot trigger its ban. The handler needs Guilds and GuildMessages intents; it does not inspect message content or depend on Message Content access. The worker already requests Message Content for its other features.

## Verification

Run `npm run test:bot` from `Software` for mocked Discord behaviour tests. After deploying/restarting the bot service, verify the category, warning and effective permissions with Discord's role preview. For a live ban test, use a disposable test account below the bot's role, then check the audit entry, one-hour cleanup and counter. Automated tests never contact Discord or ban real members.
