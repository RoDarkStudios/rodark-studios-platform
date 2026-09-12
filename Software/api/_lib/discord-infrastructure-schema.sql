create table if not exists discord_infrastructure_state (
    guild_id text primary key,
    initialized boolean not null default false,
    maintenance boolean not null default false,
    resources jsonb not null default '{"role":{},"channel":{}}',
    active jsonb,
    drift jsonb,
    last_checked_at timestamptz,
    last_success_at timestamptz,
    updated_at timestamptz not null default now()
);
create table if not exists discord_infrastructure_jobs (
    id uuid primary key,
    guild_id text not null references discord_infrastructure_state(guild_id),
    version text not null,
    actor jsonb not null,
    status text not null check (status in ('preview_queued','previewing','ready','deploy_queued','applying','succeeded','failed','stale')),
    plan jsonb,
    progress jsonb not null default '[]',
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz,
    finished_at timestamptz
);
alter table discord_infrastructure_jobs add column if not exists auto_apply boolean not null default false;
create unique index if not exists discord_infrastructure_one_operation
    on discord_infrastructure_jobs(guild_id)
    where status in ('preview_queued','previewing','deploy_queued','applying');
create index if not exists discord_infrastructure_recent
    on discord_infrastructure_jobs(guild_id, created_at desc);
