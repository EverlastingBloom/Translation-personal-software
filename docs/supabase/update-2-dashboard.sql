-- Update 2: the admin dashboard (contributions and the weekly report).
-- Only for a database set up before this change: Supabase -> SQL Editor -> New query -> paste -> Run.

-- Who did how much: everything so far, and when each person was last active.
-- Reviews count every decision made by a person (also on imported lines), never the import itself.
drop function if exists public.people_stats(bigint);
create function public.people_stats(p_project bigint)
returns table (name text, approved bigint, waiting bigint, not_used bigint, reviewed bigint, notes bigint,
               last_active timestamptz)
language sql stable as $$
  select name, sum(a), sum(w), sum(n_u), sum(r), sum(nt), max(t) from (
    select author_name as name, (status = 'approved')::int as a, (status = 'pending')::int as w,
           (status in ('rejected', 'superseded'))::int as n_u, 0 as r, 0 as nt, created_at as t
      from versions where project_id = p_project
    union all
    select decided_by_name, 0, 0, 0, 1, 0, decided_at from versions
      where project_id = p_project and decided_by_name <> 'Imported'
    union all
    select author_name, 0, 0, 0, 0, 1, created_at from notes where project_id = p_project
  ) x
  group by name
  order by 2 desc, 1
$$;

-- Week by week (a week starts on Monday, in the reader's time zone): what each person did.
-- written = new versions, approved = their versions approved that week, reviewed = versions they
-- approved or turned down, notes = notes written. Imports without a known author don't count.
create or replace function public.weekly_activity(p_project bigint, p_weeks int default 12, p_tz text default 'UTC')
returns table (week date, name text, written bigint, approved bigint, reviewed bigint, notes bigint)
language sql stable as $$
  with since as (
    select (date_trunc('week', now() at time zone p_tz) - make_interval(weeks => p_weeks - 1)) at time zone p_tz as t
  ), x as (
    select author_name as name, created_at as t, 1 as w, 0 as a, 0 as r, 0 as n
      from versions where project_id = p_project and author_name <> 'Imported'
    union all
    select author_name, decided_at, 0, 1, 0, 0 from versions
      where project_id = p_project and status in ('approved', 'superseded')
        and author_name <> 'Imported' and decided_by_name <> 'Imported'
    union all
    select decided_by_name, decided_at, 0, 0, 1, 0 from versions
      where project_id = p_project and decided_by_name <> 'Imported'
    union all
    select author_name, created_at, 0, 0, 0, 1 from notes
      where project_id = p_project and author_name <> 'Imported'
  )
  select (date_trunc('week', x.t at time zone p_tz))::date, x.name, sum(x.w), sum(x.a), sum(x.r), sum(x.n)
  from x, since
  where x.t >= since.t
  group by 1, 2
  order by 1, 2
$$;

-- Lines that had an approved translation at the end of each week (the progress chart).
create or replace function public.weekly_progress(p_project bigint, p_weeks int default 12, p_tz text default 'UTC')
returns table (week date, approved bigint, total bigint)
language sql stable as $$
  with first as (
    select min(decided_at) as t from versions
    where project_id = p_project and status in ('approved', 'superseded')
    group by line_id
  ), weeks as (
    select (date_trunc('week', now() at time zone p_tz) - make_interval(weeks => g))::date as week
    from generate_series(0, p_weeks - 1) g
  )
  select w.week,
         (select count(*) from first where first.t < (w.week + 7)::timestamp at time zone p_tz),
         (select count(*) from lines where project_id = p_project)
  from weeks w
  order by w.week
$$;

-- Where the work went in one week: the scenes with the most new versions and approvals.
create or replace function public.week_scenes(p_project bigint, p_week date, p_tz text default 'UTC',
                                              p_limit int default 8)
returns table (grp text, scene text, written bigint, approved bigint, people text[])
language sql stable as $$
  with r as (
    select p_week::timestamp at time zone p_tz as a, (p_week + 7)::timestamp at time zone p_tz as b
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
