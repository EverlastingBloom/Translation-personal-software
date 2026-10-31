-- Update 8: security hardening and speed-ups. Only for a database set up before this change
-- (after update 7): Supabase -> SQL Editor -> New query -> paste -> Run.

-- ---------------------------------------------------------------------------------------------
-- Security
-- A suggestion's author can change its words - nothing else (not its author, line, dates or status).
-- Decisions and votes go through the functions below, which run with the owner's rights.
revoke update on public.versions from anon, authenticated;
grant update (text) on public.versions to authenticated;
-- Sizes: nobody fills the database with megabytes of text.
alter table public.versions add constraint versions_text_size check (length(text) <= 10000) not valid;
alter table public.claims add constraint claims_name_size check (length(grp) <= 200 and length(scene) <= 200) not valid;

-- A new version or note always belongs to its line's project, and a new suggestion carries no decision.
create or replace function public.stamp_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (new.imported and is_admin()) then
    new.author := auth.uid();
    new.author_name := coalesce((select display_name from profiles where id = auth.uid()), '');
    new.imported := false;
    new.created_at := now();
  end if;
  -- a version or note always belongs to its line's project
  new.project_id := coalesce((select project_id from lines where id = new.line_id), new.project_id);
  -- a new suggestion carries no decision (nobody can hand out "review" credit by inserting one)
  if tg_table_name = 'versions' then  -- (nested: notes have no status column)
    if new.status = 'pending' then
      new.decided_by_name := null;
      new.decided_at := null;
    end if;
  end if;
  return new;
end $$;

-- "Who's online" (live presence) only for the team, not for anyone who has the site's public key.
-- (Supabase keeps live channels in realtime.messages; the page joins "presence-team" as a private channel.)
do $do$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$create policy "team presence: see" on realtime.messages for select to authenticated
      using ((select public.is_member()) and realtime.topic() = 'presence-team' and extension = 'presence')$p$;
    execute $p$create policy "team presence: join" on realtime.messages for insert to authenticated
      with check ((select public.is_member()) and realtime.topic() = 'presence-team' and extension = 'presence')$p$;
  end if;
end $do$;

-- ---------------------------------------------------------------------------------------------
-- Speed: the rules check who's asking once per query instead of once per row.
drop policy if exists "admin manages invites" on public.invites;
create policy "admin manages invites" on public.invites for all using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "team sees the team" on public.profiles;
create policy "team sees the team" on public.profiles for select using ((select is_member()));
drop policy if exists "admin changes roles" on public.profiles;
create policy "admin changes roles" on public.profiles for update using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "admin removes people" on public.profiles;
create policy "admin removes people" on public.profiles for delete using ((select is_admin()) and id <> (select auth.uid()));
drop policy if exists "team reads projects" on public.projects;
create policy "team reads projects" on public.projects for select using ((select is_member()));
drop policy if exists "admin writes projects" on public.projects;
create policy "admin writes projects" on public.projects for all using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "team reads lines" on public.lines;
create policy "team reads lines" on public.lines for select using ((select is_member()));
drop policy if exists "admin writes lines" on public.lines;
create policy "admin writes lines" on public.lines for all using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "team reads versions" on public.versions;
create policy "team reads versions" on public.versions for select using ((select is_member()));
drop policy if exists "team suggests" on public.versions;
create policy "team suggests" on public.versions for insert
  with check ((select is_member()) and (status = 'pending' or (select is_admin())));
drop policy if exists "change own suggestion" on public.versions;
create policy "change own suggestion" on public.versions for update
  using (author = (select auth.uid()) and status = 'pending') with check (author = (select auth.uid()) and status = 'pending');
drop policy if exists "withdraw own suggestion" on public.versions;
create policy "withdraw own suggestion" on public.versions for delete
  using ((author = (select auth.uid()) and status = 'pending') or (select is_admin()));
drop policy if exists "team reads notes" on public.notes;
create policy "team reads notes" on public.notes for select using ((select is_member()));
drop policy if exists "team writes notes" on public.notes;
create policy "team writes notes" on public.notes for insert with check ((select is_member()));
drop policy if exists "delete own note" on public.notes;
create policy "delete own note" on public.notes for delete using (author = (select auth.uid()) or (select is_admin()));
drop policy if exists "team reads claims" on public.claims;
create policy "team reads claims" on public.claims for select using ((select is_member()));
drop policy if exists "team claims" on public.claims;
create policy "team claims" on public.claims for insert with check ((select is_member()));
drop policy if exists "unclaim own" on public.claims;
create policy "unclaim own" on public.claims for delete using (user_id = (select auth.uid()));
drop policy if exists "read own messages" on public.messages;
create policy "read own messages" on public.messages for select
  using ((select is_member()) and (select auth.uid()) in (sender, recipient));
drop policy if exists "write to a teammate" on public.messages;
create policy "write to a teammate" on public.messages for insert
  with check ((select is_member()) and sender = (select auth.uid()) and recipient <> (select auth.uid()));
drop policy if exists "team reads votes" on public.votes;
create policy "team reads votes" on public.votes for select using ((select is_member()));
drop policy if exists "team reads the glossary" on public.glossary;
create policy "team reads the glossary" on public.glossary for select using ((select is_member()));
drop policy if exists "admin writes the glossary" on public.glossary;
create policy "admin writes the glossary" on public.glossary for all using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications for select using (user_id = (select auth.uid()));

-- Indexes for the activity feed, your recent translations and the daily numbers.
create index if not exists versions_author on public.versions (author, created_at desc);
create index if not exists versions_created on public.versions (created_at desc);
create index if not exists versions_project_created on public.versions (project_id, created_at);
create index if not exists versions_project_decided on public.versions (project_id, decided_at);
create index if not exists notes_created on public.notes (created_at desc);
create index if not exists votes_created on public.votes (created_at desc);

-- At the end of each day: lines with an approved translation, and versions waiting for review.
-- One pass over the versions (counts per day, then running totals) - not one pass per day.
create or replace function public.daily_progress(p_project bigint, p_days int default 30, p_tz text default 'UTC')
returns table (day date, approved bigint, waiting bigint, total bigint)
language sql stable as $$
  with days as (
    select (date_trunc('day', now() at time zone p_tz) - make_interval(days => g))::date as day
    from generate_series(0, least(greatest(p_days, 1), 366) - 1) g
  ), ev as (  -- per day: lines approved for the first time, versions written, versions decided
    select (x.t at time zone p_tz)::date as day, sum(x.a) as a, sum(x.c) as c, sum(x.r) as r
    from (
      select min(decided_at) as t, 1 as a, 0 as c, 0 as r from versions
        where project_id = p_project and status in ('approved', 'superseded') group by line_id
      union all
      select created_at, 0, 1, 0 from versions where project_id = p_project
      union all
      select decided_at, 0, 0, 1 from versions
        where project_id = p_project and status <> 'pending' and decided_at is not null
    ) x
    where x.t is not null
    group by 1
  ), before as (
    select coalesce(sum(a), 0) as a, coalesce(sum(c), 0) - coalesce(sum(r), 0) as w
    from ev where ev.day < (select min(day) from days)
  )
  select d.day,
         (b.a + sum(coalesce(e.a, 0)) over w)::bigint,
         (b.w + sum(coalesce(e.c, 0) - coalesce(e.r, 0)) over w)::bigint,
         (select count(*) from lines where project_id = p_project)
  from days d left join ev e on e.day = d.day cross join before b
  window w as (order by d.day)
  order by d.day
$$;

-- Caps, so nobody can ask for a million days or rows.
create or replace function public.daily_activity(p_project bigint, p_days int default 30, p_tz text default 'UTC')
returns table (day date, name text, written bigint, approved bigint, reviewed bigint, notes bigint)
language sql stable as $$
  with since as (
    select (date_trunc('day', now() at time zone p_tz) - make_interval(days => least(greatest(p_days, 1), 366) - 1)) at time zone p_tz as t
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

create or replace function public.recent_activity(p_limit int default 20)
returns table (kind text, at timestamptz, who text, project_id bigint, line_id bigint, grp text, scene text, body text)
language sql stable as $$
  select x.kind, x.at, x.who, x.project_id, x.line_id, l.grp, l.scene, x.body
  from (
    (select 'wrote' as kind, created_at as at, author_name as who, project_id, line_id, left(text, 120) as body
       from versions where not imported order by created_at desc limit least(greatest(p_limit, 1), 100))
    union all
    (select status, decided_at, decided_by_name, project_id, line_id, left(text, 120)
       from versions where status in ('approved', 'rejected', 'superseded') and decided_at is not null
        and decided_by_name <> 'Imported' order by decided_at desc limit least(greatest(p_limit, 1), 100))
    union all
    (select 'note', created_at, author_name, project_id, line_id, left(body, 120)
       from notes where not imported order by created_at desc limit least(greatest(p_limit, 1), 100))
    union all
    (select case when agree then 'agree' else 'disagree' end, created_at, voter_name, project_id, line_id, coalesce(reason, '')
       from votes order by created_at desc limit least(greatest(p_limit, 1), 100))
  ) x
  join lines l on l.id = x.line_id
  order by x.at desc
  limit least(greatest(p_limit, 1), 100)
$$;
