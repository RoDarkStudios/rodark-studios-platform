create table if not exists discord_bot_staff_actions (
    interaction_id text primary key,
    guild_id text not null,
    actor_id text not null,
    target_id text not null,
    action text not null check (action in ('ban', 'kick')),
    reason text not null,
    administrator boolean not null,
    outcome text not null default 'pending' check (outcome in ('pending', 'succeeded', 'failed', 'unconfirmed')),
    created_at timestamptz not null default clock_timestamp(),
    quota_until timestamptz not null default (clock_timestamp() + interval '61 minutes'),
    log_message_id text
);

create index if not exists discord_bot_staff_actions_quota_idx
    on discord_bot_staff_actions (guild_id, actor_id, quota_until) where outcome <> 'failed';

create index if not exists discord_bot_staff_actions_log_idx
    on discord_bot_staff_actions (guild_id, created_at) where log_message_id is null;
