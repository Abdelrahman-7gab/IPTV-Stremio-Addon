create or replace function public.overwrite_xtream_snapshot(
    p_snapshot_id uuid,
    p_user_id uuid,
    p_user_email text,
    p_snapshot_data jsonb,
    p_stats jsonb default '{}'::jsonb
)
returns table (
    id uuid,
    slug text,
    title text,
    last_refreshed_at timestamptz,
    next_allowed_at timestamptz,
    stats jsonb
)
language plpgsql
security definer
set search_path = public
set statement_timeout = '0'
as $$
declare
    v_snapshot public.xtream_snapshots%rowtype;
    v_now timestamptz := now();
    v_next timestamptz;
begin
    select *
    into v_snapshot
    from public.xtream_snapshots
    where public.xtream_snapshots.id = p_snapshot_id
    for update;

    if not found then
        raise exception 'Snapshot not found';
    end if;

    if v_snapshot.last_refreshed_at is not null then
        v_next := v_snapshot.last_refreshed_at + interval '30 minutes';
        if v_next > v_now then
            insert into public.snapshot_refresh_logs (
                snapshot_id,
                user_id,
                user_email,
                status,
                message,
                finished_at,
                stats
            ) values (
                p_snapshot_id,
                p_user_id,
                p_user_email,
                'blocked',
                'Cooldown active',
                v_now,
                jsonb_build_object('nextAllowedAt', v_next)
            );

            raise exception 'Cooldown active until %', v_next;
        end if;
    end if;

    update public.xtream_snapshots
    set snapshot_data = coalesce(p_snapshot_data, '{}'::jsonb),
        stats = coalesce(p_stats, '{}'::jsonb),
        last_refreshed_at = v_now,
        last_refresh_by = p_user_id,
        updated_at = v_now
    where public.xtream_snapshots.id = p_snapshot_id
    returning * into v_snapshot;

    insert into public.snapshot_refresh_logs (
        snapshot_id,
        user_id,
        user_email,
        status,
        message,
        finished_at,
        stats
    ) values (
        p_snapshot_id,
        p_user_id,
        p_user_email,
        'success',
        'Snapshot overwritten',
        v_now,
        coalesce(p_stats, '{}'::jsonb)
    );

    return query
    select
        v_snapshot.id,
        v_snapshot.slug,
        v_snapshot.title,
        v_snapshot.last_refreshed_at,
        v_snapshot.last_refreshed_at + interval '30 minutes',
        v_snapshot.stats;
end;
$$;
