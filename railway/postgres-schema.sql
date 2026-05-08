create table if not exists admin_game_config (
    id smallint primary key check (id = 1),
    production_universe_id bigint not null,
    test_universe_id bigint not null,
    development_universe_id bigint not null,
    updated_by_user_id text,
    updated_by_username text,
    updated_at timestamptz not null default now()
);

create table if not exists discord_bot_control (
    id smallint primary key check (id = 1),
    desired_enabled boolean not null default false,
    runtime_status text not null default 'offline',
    last_seen_at timestamptz,
    last_error text,
    guild_id text,
    content_rules_channel_id text,
    content_info_channel_id text,
    content_roles_channel_id text,
    content_staff_info_channel_id text,
    content_game_test_info_channel_id text,
    tickets_category_channel_id text,
    tickets_panel_channel_id text,
    tickets_panel_message_id text,
    tickets_helper_role_ids text[] not null default '{}',
    level_system_enabled boolean not null default false,
    level_announcement_channel_id text,
    level_attachment_unlock_level integer not null default 5,
    level_mention_enabled boolean not null default true,
    leaderboard_role_enabled boolean not null default false,
    leaderboard_role_ordered_datastore_name text,
    leaderboard_role_ordered_datastore_scope text not null default 'global',
    leaderboard_role_key_prefix text not null default '',
    leaderboard_role_top_size integer not null default 100,
    leaderboard_role_sync_interval_minutes integer not null default 5,
    leaderboard_role_id text,
    leaderboard_role_name text not null default 'Leaderboard Player',
    updated_at timestamptz not null default now(),
    updated_by_user_id text,
    updated_by_username text
);

create table if not exists admin_platform_settings (
    id smallint primary key check (id = 1),
    openai_model text not null default 'gpt-5.4',
    updated_by_user_id text,
    updated_by_username text,
    updated_at timestamptz not null default now()
);

insert into admin_platform_settings (id)
values (1)
on conflict (id) do nothing;

insert into discord_bot_control (id)
values (1)
on conflict (id) do nothing;

create sequence if not exists discord_bot_ticket_id_seq
    as bigint
    start with 1
    increment by 1
    no minvalue
    no maxvalue
    cache 1;

create table if not exists discord_bot_tickets (
    ticket_id bigint primary key,
    guild_id text not null,
    channel_id text unique,
    opener_user_id text not null,
    status text not null default 'open',
    created_at timestamptz not null default now(),
    closed_at timestamptz,
    closed_by_user_id text
);

with ranked_open_tickets as (
    select
        ticket_id,
        row_number() over (
            partition by guild_id, opener_user_id
            order by created_at asc, ticket_id asc
        ) as open_rank
    from discord_bot_tickets
    where status = 'open'
)
update discord_bot_tickets
set
    status = 'closed',
    closed_at = coalesce(closed_at, now())
where ticket_id in (
    select ticket_id
    from ranked_open_tickets
    where open_rank > 1
);

create unique index if not exists discord_bot_tickets_one_open_per_user_idx
on discord_bot_tickets (guild_id, opener_user_id)
where status = 'open';

create table if not exists discord_bot_ticket_transcripts (
    ticket_id bigint primary key,
    guild_id text not null,
    channel_id text not null,
    channel_name text not null,
    opener_user_id text not null,
    closed_by_user_id text,
    created_at timestamptz,
    closed_at timestamptz not null default now(),
    message_count integer not null default 0,
    transcript jsonb not null default '[]'::jsonb
);

create table if not exists discord_bot_member_levels (
    guild_id text not null,
    user_id text not null,
    message_count integer not null default 0,
    level integer not null default 0,
    last_message_at timestamptz,
    updated_at timestamptz not null default now(),
    primary key (guild_id, user_id)
);

create table if not exists discord_bot_leaderboard_role_assignments (
    guild_id text not null,
    user_id text not null,
    roblox_user_id text not null,
    role_id text not null,
    level_value bigint,
    assigned_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    primary key (guild_id, user_id)
);
