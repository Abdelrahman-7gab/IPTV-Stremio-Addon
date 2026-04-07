create table if not exists public.app_config (
    key text primary key,
    value text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

drop trigger if exists set_app_config_updated_at on public.app_config;
create trigger set_app_config_updated_at
before update on public.app_config
for each row
execute function public.set_current_timestamp_updated_at();

insert into public.app_config (key, value)
values ('install_code', 'potato')
on conflict (key) do nothing;
