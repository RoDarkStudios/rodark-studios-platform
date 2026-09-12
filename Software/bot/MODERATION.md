# Contextual community moderation

This is the bot's only AI feature. Ordinary tickets have no AI classification or response handling. The existing anti-spam honeypot operates independently and still bans immediately.

## Policy and actions

- Swearing, sexual slang without harassment, game frustration, criticism, unpopular opinions, friendly roasts and mutual banter are allowed.
- Clear bullying, aggressive personal attacks and hateful abuse warrant a timeout. Requests to stop and repeated targeting matter; claiming "just joking" does not excuse abuse.
- Racial slurs, including both spellings specified by the server owner and deliberately disguised variants, are serious violations even when used casually. Good-faith reports, quotations condemning abuse and educational discussion are evaluated in context and must not be punished as direct slur use.
- Credible real-world threats, targeted encouragement of suicide, serious racist abuse and persistent serious bullying request a human ban review. In-game combat threats are distinguished from real threats.
- Uncertain but substantial concerns go to moderators without a timeout; weak concerns are allowed. The model's confidence label is a decision gate, not a calibrated probability.

Automatic timeouts are **10 minutes** for an ordinary clear violation, **30 minutes** after another non-dismissed timeout within 24 hours, and **60 minutes** for severe violations. Repeated serious incidents are escalated. Existing timeouts are never shortened or extended. The AI never bans, deletes messages, answers tickets or issues free-form commands.

The actual server owner, Owner-role members, administrators, moderators and members outside the bot's role hierarchy receive human review instead of automated timeouts. This protection is specific to AI moderation; it does not alter honeypot behaviour.

## Scheduling and scope

`gpt-5.6-luna` and `reasoning.effort=high` are fixed in `moderation-policy.js`. There is no model switching or fallback model, and legacy generic/model settings do not override them.

A single worker timer runs every **60 seconds**. Each active channel/thread can start at most one AI review per minute, enforced by PostgreSQL across restarts and worker replicas. New messages do not trigger earlier requests, even in busy channels. Empty queues make no API calls. Pending retries can still run after people stop talking. Hosting and database charges remain independent of API activity.

Every text message and substantive text edit in eligible community channels enters a durable queue. Reviews group up to 50 messages, with a character budget that can make groups smaller; overflow stays queued for later minutes. Two channels may run concurrently. Long-running reviews, API backoff and traffic bursts can delay moderation beyond one minute. A growing backlog alerts moderators rather than making extra paid requests or silently discarding a busy minute.

The model receives recent conversation context (up to 30 stored messages, initial channel history where needed, and up to 5 missing reply references) plus recent non-dismissed timeout cases for participating members. Historical context cannot itself become a new punishment. Context is bounded, not a complete lifetime history.

Scope includes public text/announcement channels and public threads, including channels visible through ordinary member roles. DMs, private threads, staff-only channels, configured support tickets, the moderation log, the honeypot, bots, webhooks and system events are excluded. Explicit exclusions also apply to category/parent IDs. **This is text moderation:** captions are reviewed; images, audio, stickers and linked pages are not opened or visually classified.

## Setup on the Railway bot service

The existing `DISCORD_BOT_TOKEN` and `DATABASE_URL` remain required. Set `OPENAI_API_KEY` on the bot service. AI moderation is enabled by default; `DISCORD_AI_MODERATION_ENABLED=false` disables it independently of tickets, levels and the honeypot.

The bot needs **Moderate Members**, **Manage Channels** and **Manage Roles**, with its role above members it should time out. It needs **View Channel** and **Read Message History** in moderated channels, plus the existing Message Content intent enabled in the Discord Developer Portal. Log overwrites grant the bot Send Messages, Embed Links and Mention Everyone so it can ping an unmentionable moderator role; payloads permit only the selected moderator roles, never `@everyone` or arbitrary users.

By default, the bot finds human roles named `Moderator`, `Moderators` or `Staff`. If none exist, it finds roles with Moderate Members. Set `DISCORD_MODERATOR_ROLE_IDS` to comma-separated IDs to override this. A missing/invalid review role or insufficient bot permissions prevents automatic moderation and reports a configuration error.

The bot creates a private `ai-moderation-log` channel, visible to reviewers and Owners. It reuses its marked channel after restarts and repairs its permissions. `DISCORD_MODERATION_LOG_CHANNEL_ID` can select a **dedicated text channel whose overwrites the bot may replace**. Do not point it at an unrelated existing channel. `DISCORD_MODERATION_EXCLUDED_CHANNEL_IDS` accepts comma-separated channel/category IDs.

Cases show the member, reason, action, evidence links and excerpts. Serious cases explicitly request ban review and ping the moderator roles. **Mark reviewed** records the reviewer without banning. **Dismiss / undo bot timeout** dismisses a mistaken case, excludes it from repeat-offence history, and removes its timeout only if the current expiry still matches that exact bot action. A later timeout imposed or changed by a moderator is preserved.

## Persistence, failure behaviour and cost

Tables are created lazily from `api/_lib/discord-moderation-schema.sql`, also included in the deployment schema:

- `discord_bot_moderation_messages`: queued versions and bounded recent context; retained for 24 hours.
- `discord_bot_moderation_channels`: durable per-channel review intervals.
- `discord_bot_moderation_cases`: action recovery, evidence, moderator decisions and notification IDs; retained for 30 days.
- `discord_bot_moderation_usage`: daily request/failure counts and actual input, cached-input, output and reasoning tokens returned by OpenAI; retained for 90 days.

Queue acknowledgements and case creation are transactional. Changed or deleted evidence cannot be punished from an old response. Evidence and author are fetched again before a timeout. Case actions use absolute timeout expiries, member locks and durable outcomes to avoid duplicate/extended punishments after a restart or notification failure. Cases or evidence over ten minutes old become human reviews rather than delayed automatic timeouts. Messages missed while the worker/database is offline are not retroactively punished.

Malformed, refused, incomplete or misattributed model responses cause no punishment. Failed batches retry at most three times, with API backoff from one to fifteen minutes and a moderator notice; after the third failure, manual review is needed. A 55-second request deadline and an 8,192-token output limit bound individual reviews. The output limit includes reasoning, so an incomplete review may incur charges without a decision. These limits are not a daily spending cap.

Repeated rules/context and reasoning tokens are billable. One continuously active channel can make up to 43,200 requests in a 30-day month; the actual token count determines the cost. Multiple channels add usage. No fixed monthly price is promised. Usage may be unavailable for transport failures; database outages can also prevent usage recording.

OpenAI requests use `store: false`. This disables stored Responses API conversation state; it does not by itself guarantee zero provider retention. Community text and selected evidence are sent to OpenAI for each review. Raw message context stays local only for the retention period above.

## Validation

Run `npm run test:bot` from `Software` for isolated Discord/API tests, ordinary ticket regression coverage and PostgreSQL persistence tests using PGlite (development dependency only). No live Discord or OpenAI credentials are used by these tests.

Run `npm run eval:moderation` with `OPENAI_API_KEY` to evaluate 20 synthetic conversation examples through the exact Luna/high policy. This explicitly makes paid API calls, prints misses/false positives and usage, and never connects to Discord or applies punishments. It is deliberately separate from unit tests: mocked decisions cannot establish the model's real judgement. Review results on actual community examples as well as these fixtures when tuning the policy.

API references: [Responses and structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
