-- Update 7: notifications, a reason with a 👎, the glossary, a team weekly goal, the activity feed and
-- daily statistics. Only for a database set up before this change (after update 6):
-- Supabase -> SQL Editor -> New query -> paste -> Run.

-- ---------------------------------------------------------------------------------------------
-- A reason with a vote (mostly for 👎, so the translator knows what to fix).
alter table public.votes add column reason text check (reason is null or length(reason) <= 500);

-- The team's weekly goal per project: translations to write in a week (0 = no goal).
alter table public.projects add column weekly_goal int not null default 0 check (weekly_goal >= 0);

-- The glossary: agreed translations of names and terms, shown as hints while translating.
create table public.glossary (
  id         bigint generated always as identity primary key,
  project_id bigint not null references public.projects on delete cascade,
  source     text not null check (length(source) between 1 and 200),
  target     text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index glossary_project on public.glossary (project_id);
alter table public.glossary enable row level security;
create policy "team reads the glossary" on public.glossary for select using (is_member());
create policy "admin writes the glossary" on public.glossary for all using (is_admin()) with check (is_admin());

-- Notifications: your translation was approved or turned down, someone disagreed (and why), someone
-- replied on a line you worked on, or mentioned you with @Name. Only you see yours.
create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles on delete cascade,
  kind       text not null check (kind in ('approved', 'rejected', 'vote', 'note', 'mention')),
  project_id bigint references public.projects on delete cascade,
  line_id    bigint references public.lines on delete cascade,
  actor_name text not null default '',
  body       text not null default '',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "read own notifications" on public.notifications for select using (user_id = auth.uid());

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns void
language sql security definer set search_path = public as $$
  update notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
$$;

-- Your translation was decided on (not when you decided on it yourself).
create or replace function private.notify_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') and new.author is not null
     and new.author is distinct from auth.uid() then
    insert into notifications (user_id, kind, project_id, line_id, actor_name, body)
    values (new.author, new.status, new.project_id, new.line_id, coalesce(new.decided_by_name, ''), left(new.text, 200));
  end if;
  return new;
end $$;
create trigger notify_decision after update of status on public.versions
  for each row execute function private.notify_decision();

-- Someone disagreed with your translation.
create or replace function private.notify_vote() returns trigger
language plpgsql security definer set search_path = public as $$
declare v versions;
begin
  select * into v from versions where id = new.version_id;
  if not new.agree and v.author is not null and v.author <> new.voter then
    insert into notifications (user_id, kind, project_id, line_id, actor_name, body)
    values (v.author, 'vote', new.project_id, new.line_id, new.voter_name,
            coalesce(nullif(new.reason, ''), 'disagreed with your translation'));
  end if;
  return new;
end $$;
create trigger notify_vote after insert or update of agree, reason on public.votes
  for each row execute function private.notify_vote();

-- A note: @mentions, and a reply for everyone else who worked on that line.
create or replace function private.notify_note() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.imported or new.author is null then return new; end if;
  insert into notifications (user_id, kind, project_id, line_id, actor_name, body)
  select p.id, 'mention', new.project_id, new.line_id, new.author_name, left(new.body, 200)
  from profiles p
  where p.id <> new.author and position(lower('@' || p.display_name) in lower(new.body)) > 0;
  insert into notifications (user_id, kind, project_id, line_id, actor_name, body)
  select distinct x.who, 'note', new.project_id, new.line_id, new.author_name, left(new.body, 200)
  from (select author as who from notes where line_id = new.line_id and id <> new.id
        union select author from versions where line_id = new.line_id) x
  join profiles p on p.id = x.who
  where x.who <> new.author and position(lower('@' || p.display_name) in lower(new.body)) = 0;
  return new;
end $$;
create trigger notify_note after insert on public.notes
  for each row execute function private.notify_note();

-- ---------------------------------------------------------------------------------------------
-- vote() takes an optional reason now (so the old one has to go first).
drop function if exists public.vote(bigint, boolean);
create or replace function public.vote(p_id bigint, p_agree boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not (me.can_review or me.is_admin) or (me.is_admin and me.admin_active) then
    raise exception 'Only people who can vote can vote (the admin approves directly).';
  end if;
  select * into v from versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then raise exception 'That version is no longer waiting.'; end if;
  if private.is_author(v, me.id) then raise exception 'You can''t vote on your own translation.'; end if;
  if p_agree is null then
    delete from votes where version_id = p_id and voter = me.id;
  else
    insert into votes (version_id, line_id, project_id, voter, voter_name, agree, reason)
    values (p_id, v.line_id, v.project_id, me.id, me.display_name, p_agree, nullif(left(trim(p_reason), 500), ''))
    on conflict (version_id, voter) do update set agree = excluded.agree, reason = excluded.reason, created_at = now();
  end if;
  return private.settle_votes(p_id);
end $$;

-- get_lines: votes now carry their reason.
create or replace function public.get_lines(p_project bigint, p_grp text default null, p_scene text default null,
                                 p_state text default null, p_search text default null,
                                 p_ids bigint[] default null, p_limit int default 1000,
                                 p_author text default null, p_unvoted boolean default false)
returns jsonb language sql stable as $$
  with base as (
    select l.id, l.idx, l.key, l.grp, l.scene, l.speaker, l.source, l.reference,
           exists (select 1 from versions v where v.line_id = l.id and v.status = 'approved') as a,
           exists (select 1 from versions v where v.line_id = l.id and v.status = 'pending') as p
    from lines l
    where l.project_id = p_project
      and (p_ids is null or l.id = any (p_ids))
      and (p_grp is null or l.grp = p_grp)
      and (p_scene is null or l.scene = p_scene)
      and (p_author is null
           or exists (select 1 from versions v where v.line_id = l.id and v.status = 'pending'
                      and v.author_name = p_author))
      and (not p_unvoted  -- a waiting version that isn't mine and that I haven't voted on
           or exists (select 1 from versions v where v.line_id = l.id and v.status = 'pending'
                      and not exists (select 1 from votes x where x.version_id = v.id and x.voter = auth.uid())
                      and not (case when v.imported
                                    then lower(v.author_name) = lower(coalesce((select display_name from profiles where id = auth.uid()), ''))
                                    else coalesce(v.author = auth.uid(), false) end)))
      and (p_search is null
           or l.source ilike '%' || p_search || '%' or l.key ilike '%' || p_search || '%'
           or l.speaker ilike '%' || p_search || '%'
           or exists (select 1 from versions v where v.line_id = l.id and v.status in ('approved', 'pending')
                      and v.text ilike '%' || p_search || '%'))
  ), picked as (
    select * from base
    where p_state is null
       or (p_state = 'review' and p)
       or (p_state = 'untranslated' and not a and not p)
       or (p_state = 'done' and a and not p)
       or (p_state = 'todo' and not (a and not p))
    order by idx
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'idx', b.idx, 'key', b.key, 'grp', b.grp, 'scene', b.scene, 'speaker', b.speaker,
      'source', b.source, 'reference', b.reference,
      'versions', coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object('votes', coalesce(
                                (select jsonb_agg(jsonb_build_object('voter', x.voter, 'voter_name', x.voter_name,
                                                                     'agree', x.agree, 'reason', x.reason,
                                                                     'created_at', x.created_at)
                                                  order by x.created_at)
                                 from votes x where x.version_id = v.id), '[]'::jsonb))
                                      order by v.created_at, v.id)
                            from versions v where v.line_id = b.id), '[]'::jsonb),
      'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
                         from notes n where n.line_id = b.id), '[]'::jsonb)
    ) order by b.idx), '[]'::jsonb)
  from picked b
$$;

-- ---------------------------------------------------------------------------------------------
-- What the team did lately, newest first (the welcome page's activity feed).
create or replace function public.recent_activity(p_limit int default 20)
returns table (kind text, at timestamptz, who text, project_id bigint, line_id bigint, grp text, scene text, body text)
language sql stable as $$
  select x.kind, x.at, x.who, x.project_id, x.line_id, l.grp, l.scene, x.body
  from (
    (select 'wrote' as kind, created_at as at, author_name as who, project_id, line_id, left(text, 120) as body
       from versions where not imported order by created_at desc limit p_limit)
    union all
    (select status, decided_at, decided_by_name, project_id, line_id, left(text, 120)
       from versions where status in ('approved', 'rejected', 'superseded') and decided_at is not null
        and decided_by_name <> 'Imported' order by decided_at desc limit p_limit)
    union all
    (select 'note', created_at, author_name, project_id, line_id, left(body, 120)
       from notes where not imported order by created_at desc limit p_limit)
    union all
    (select case when agree then 'agree' else 'disagree' end, created_at, voter_name, project_id, line_id, coalesce(reason, '')
       from votes order by created_at desc limit p_limit)
  ) x
  join lines l on l.id = x.line_id
  order by x.at desc
  limit p_limit
$$;

-- Day by day (in the reader's time zone): what each person did. Same columns as weekly_activity.
create or replace function public.daily_activity(p_project bigint, p_days int default 30, p_tz text default 'UTC')
returns table (day date, name text, written bigint, approved bigint, reviewed bigint, notes bigint)
language sql stable as $$
  with since as (
    select (date_trunc('day', now() at time zone p_tz) - make_interval(days => p_days - 1)) at time zone p_tz as t
  ), x as (
    select author_name as name, created_at as t, 1 as w, 0 as a, 0 as r, 0 as n
      from versions where project_id = p_project and author_name <> 'Imported'
    union all
    select author_name, decided_at, 0, 1, 0, 0 from versions
      where project_id = p_project and status in ('approved', 'superseded')
        and author_name <> 'Imported' and decided_by_name <> 'Imported'
    union all
    select decided_by_name, decided_at, 0, 0, 1, 0 from versions
      where project_id = p_project and decided_by_name not in ('Imported', 'Team vote')
    union all
    select voter_name, created_at, 0, 0, 1, 0 from votes where project_id = p_project
    union all
    select author_name, created_at, 0, 0, 0, 1 from notes
      where project_id = p_project and author_name <> 'Imported'
  )
  select (date_trunc('day', x.t at time zone p_tz))::date, x.name, sum(x.w), sum(x.a), sum(x.r), sum(x.n)
  from x, since
  where x.t >= since.t
  group by 1, 2
  order by 1, 2
$$;

-- At the end of each day: lines with an approved translation, and versions waiting for review.
create or replace function public.daily_progress(p_project bigint, p_days int default 30, p_tz text default 'UTC')
returns table (day date, approved bigint, waiting bigint, total bigint)
language sql stable as $$
  with first as (
    select min(decided_at) as t from versions
    where project_id = p_project and status in ('approved', 'superseded')
    group by line_id
  ), days as (
    select (date_trunc('day', now() at time zone p_tz) - make_interval(days => g))::date as day
    from generate_series(0, p_days - 1) g
  ), ends as (
    select day, (day + 1)::timestamp at time zone p_tz as e from days
  )
  select d.day,
         (select count(*) from first where first.t < d.e),
         (select count(*) from versions v where v.project_id = p_project and v.created_at < d.e
            and (v.status = 'pending' or v.decided_at >= d.e)),  -- still waiting then (decided later, or still now)
         (select count(*) from lines where project_id = p_project)
  from ends d
  order by d.day
$$;

-- How fast translations get decided: the last p_days days against the p_days before them.
create or replace function public.review_stats(p_project bigint, p_days int default 30)
returns table (period text, decided bigint, approved bigint, rejected bigint, median_hours numeric, p90_hours numeric)
language sql stable as $$
  with d as (
    select case when decided_at >= now() - make_interval(days => p_days) then 'current' else 'previous' end as period,
           status, extract(epoch from decided_at - created_at) / 3600.0 as h
    from versions
    where project_id = p_project and not imported and decided_at is not null
      and status in ('approved', 'rejected', 'superseded')
      and decided_at >= now() - make_interval(days => 2 * p_days)
  )
  select period, count(*), count(*) filter (where status in ('approved', 'superseded')),
         count(*) filter (where status = 'rejected'),
         round((percentile_cont(0.5) within group (order by h))::numeric, 1),
         round((percentile_cont(0.9) within group (order by h))::numeric, 1)
  from d group by period
$$;

-- Where the work went in any stretch of days (a day, a week): scenes with the most new versions and approvals.
create or replace function public.period_scenes(p_project bigint, p_from date, p_days int default 1, p_tz text default 'UTC',
                                                p_limit int default 8)
returns table (grp text, scene text, written bigint, approved bigint, people text[])
language sql stable as $$
  with r as (
    select p_from::timestamp at time zone p_tz as a, (p_from + p_days)::timestamp at time zone p_tz as b
  ), hit as (
    select l.grp, l.scene, l.idx, v.author_name,
           (v.author_name <> 'Imported' and v.created_at >= r.a and v.created_at < r.b) as w,
           (v.status in ('approved', 'superseded') and v.decided_by_name <> 'Imported'
            and v.decided_at >= r.a and v.decided_at < r.b) as ap
    from versions v join lines l on l.id = v.line_id, r
    where v.project_id = p_project
  )
  select grp, scene, count(*) filter (where w), count(*) filter (where ap),
         coalesce(array_agg(distinct author_name) filter (where w), '{}')
  from hit
  where w or ap
  group by grp, scene
  order by count(*) filter (where w) + count(*) filter (where ap) desc, min(idx)
  limit p_limit
$$;

alter publication supabase_realtime add table public.notifications;
