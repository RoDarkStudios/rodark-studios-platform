create table if not exists discord_bot_moderation_messages (
    message_id text primary key,
    guild_id text not null,
    channel_id text not null,
    user_id text not null,
    payload jsonb not null,
    version text not null,
    reviewed_version text,
    attempts integer not null default 0,
    deleted boolean not null default false,
    received_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists discord_bot_moderation_pending_idx
    on discord_bot_moderation_messages (guild_id, channel_id, received_at)
    where not deleted and reviewed_version is distinct from version and attempts < 3;

create table if not exists discord_bot_moderation_channels (
    channel_id text primary key,
    next_review_at timestamptz not null
);

create table if not exists discord_bot_moderation_cases (
    case_id text primary key,
    guild_id text not null,
    user_id text not null,
    data jsonb not null,
    created_at timestamptz not null default now()
);
create index if not exists discord_bot_moderation_cases_guild_idx
    on discord_bot_moderation_cases (guild_id, created_at);

create table if not exists discord_bot_moderation_usage (
    guild_id text not null,
    usage_date date not null,
    model text not null,
    requests bigint not null default 0,
    failures bigint not null default 0,
    input_tokens bigint not null default 0,
    cached_input_tokens bigint not null default 0,
    output_tokens bigint not null default 0,
    reasoning_tokens bigint not null default 0,
    primary key (guild_id, usage_date, model)
);
