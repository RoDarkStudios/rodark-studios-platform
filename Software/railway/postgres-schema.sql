create table if not exists admin_game_config (
    id smallint primary key check (id = 1),
    production_universe_id bigint not null,
    test_universe_id bigint,
    development_universe_id bigint,
    updated_by_user_id text,
    updated_by_username text,
    updated_at timestamptz not null default now()
);

alter table admin_game_config
    alter column test_universe_id drop not null,
    alter column development_universe_id drop not null;

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
    game_updates_channel_id text,
    game_updates_ping_everyone_enabled boolean not null default true,
    tickets_category_channel_id text,
    tickets_panel_channel_id text,
    tickets_panel_message_id text,
    tickets_helper_role_ids text[] not null default '{}',
    level_system_enabled boolean not null default false,
    level_announcement_channel_id text,
    level_attachment_unlock_level integer not null default 5,
    level_mention_enabled boolean not null default true,
    updated_at timestamptz not null default now(),
    updated_by_user_id text,
    updated_by_username text
);

insert into discord_bot_control (id)
values (1)
on conflict (id) do nothing;

drop table if exists discord_bot_leaderboard_role_assignments;

alter table discord_bot_control
    drop column if exists leaderboard_role_enabled,
    drop column if exists leaderboard_role_ordered_datastore_name,
    drop column if exists leaderboard_role_ordered_datastore_scope,
    drop column if exists leaderboard_role_key_prefix,
    drop column if exists leaderboard_role_top_size,
    drop column if exists leaderboard_role_sync_interval_minutes,
    drop column if exists leaderboard_role_id,
    drop column if exists leaderboard_role_name,
    drop column if exists leaderboard_role_hoist,
    drop column if exists leaderboard_role_icon_content_type,
    drop column if exists leaderboard_role_icon_data,
    drop column if exists leaderboard_role_icon_sha256,
    drop column if exists leaderboard_role_icon_updated_at;

create table if not exists consultation_bookings (
    id uuid primary key,
    roblox_user_id text not null,
    roblox_username text not null,
    roblox_display_name text,
    roblox_profile_url text,
    contact_discord text not null,
    contact_email text,
    game_url text not null,
    goals text not null,
    status text not null default 'checkout_created',
    payment_status text not null default 'unpaid',
    stripe_checkout_session_id text unique,
    stripe_payment_intent_id text,
    stripe_customer_email text,
    amount_total integer not null default 30000,
    currency text not null default 'usd',
    scheduled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    paid_at timestamptz
);

create index if not exists consultation_bookings_created_at_idx
on consultation_bookings (created_at desc);

create index if not exists consultation_bookings_payment_status_idx
on consultation_bookings (payment_status);

create table if not exists admin_profit_tracker_games (
    id uuid primary key,
    display_name text not null,
    universe_id bigint not null unique,
    creator_rewards_robux bigint not null default 0 check (creator_rewards_robux >= 0),
    devex_usd_per_1000_robux numeric(12, 4) not null default 3.8000 check (devex_usd_per_1000_robux > 0),
    version bigint not null default 1 check (version > 0),
    created_by_user_id text,
    created_by_username text,
    updated_by_user_id text,
    updated_by_username text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table admin_profit_tracker_games
add column if not exists creator_rewards_robux bigint not null default 0;

alter table admin_profit_tracker_games
add column if not exists devex_usd_per_1000_robux numeric(12, 4) not null default 3.8000;

create table if not exists admin_profit_tracker_expenses (
    id uuid primary key,
    game_id uuid not null references admin_profit_tracker_games(id) on delete cascade,
    amount_cents bigint not null check (amount_cents > 0),
    description text not null,
    category text not null check (category in ('animations', 'models', 'vfx', 'map', 'advertising', 'other')),
    created_by_user_id text,
    created_by_username text,
    updated_by_user_id text,
    updated_by_username text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists admin_profit_tracker_expenses_game_id_idx
on admin_profit_tracker_expenses (game_id, created_at desc);

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

create table if not exists discord_bot_honeypots (
    guild_id text primary key,
    channel_id text not null,
    warning_message_id text
);

create table if not exists discord_bot_honeypot_bans (
    message_id text primary key,
    guild_id text not null,
    channel_id text not null,
    user_id text not null,
    banned_at timestamptz not null default now()
);

create index if not exists discord_bot_honeypot_bans_guild_idx
on discord_bot_honeypot_bans (guild_id);
