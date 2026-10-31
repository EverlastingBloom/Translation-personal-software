-- Update 5: approving by vote. A translation is approved when 2/3 of the people who can vote agree;
-- the admin can still approve (or turn down) directly.
-- Only for a database set up before this change (after update 4):
-- Supabase -> SQL Editor -> New query -> paste -> Run.

-- One vote per person per version. Votes stay after the decision, as its record.
create table public.votes (
  version_id bigint not null references public.versions on delete cascade,
  line_id    bigint not null references public.lines on delete cascade,
  project_id bigint not null references public.projects on delete cascade,
  voter      uuid not null references public.profiles on delete cascade,
  voter_name text not null default '',
  agree      boolean not null,
  created_at timestamptz not null default now(),
  primary key (version_id, voter)
);
create index votes_project on public.votes (project_id);
create index votes_voter on public.votes (voter);

alter table public.votes enable row level security;
create policy "team reads votes" on public.votes for select using (is_member());
-- no insert/update/delete rules: voting only goes through vote() below

-- Changing the words of a suggestion clears its votes: they were for the old words.
create or replace function public.reset_votes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.text is distinct from old.text then delete from votes where version_id = new.id; end if;
  return new;
end $$;
create trigger reset_votes after update of text on public.versions
  for each row execute function public.reset_votes();

-- Helpers the page can't call (the private schema isn't reachable from the website).
create schema if not exists private;
revoke all on schema private from public;

-- Did this person write that version? Imported versions only know the author's name.
create or replace function private.is_author(v public.versions, p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when v.imported
              then lower(v.author_name) = lower(coalesce((select display_name from profiles where id = p), ''))
              else coalesce(v.author = p, false) end
$$;

-- Make a version the main translation (the other waiting ones are turned down), or turn it down.
create or replace function private.decide_version(p_id bigint, p_approve boolean, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare v versions;
begin
  select * into v from versions where id = p_id for update;
  if p_approve then
    update versions set status = 'superseded' where line_id = v.line_id and status = 'approved';
    update versions set status = 'rejected', decided_by_name = p_by, decided_at = now()
      where line_id = v.line_id and status = 'pending' and id <> v.id;
    update versions set status = 'approved', decided_by_name = p_by, decided_at = now() where id = v.id;
  else
    update versions set status = 'rejected', decided_by_name = p_by, decided_at = now() where id = v.id;
  end if;
end $$;

-- Who may vote on a version: everyone who "can vote", except the admin and the author.
-- Approved once agree >= ceil(2/3 of them); turned down once 2/3 can't be reached any more.
create or replace function private.settle_votes(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare v versions; pool int; need int; yes int; no int;
begin
  select * into v from versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then return 'decided'; end if;
  select count(*) into pool from profiles p
    where p.can_review and not p.is_admin and not private.is_author(v, p.id);
  if pool = 0 then return 'admin'; end if;
  need := ceil(pool * 2 / 3.0);
  select count(*) filter (where x.agree), count(*) filter (where not x.agree) into yes, no
    from votes x join profiles p on p.id = x.voter
    where x.version_id = p_id and p.can_review and not p.is_admin and not private.is_author(v, p.id);
  if yes >= need then
    perform private.decide_version(p_id, true, 'Team vote');
    return 'approved';
  elsif no > pool - need then
    perform private.decide_version(p_id, false, 'Team vote');
    return 'rejected';
  end if;
  return 'open';
end $$;

-- Approving directly: only the admin (everyone else votes).
create or replace function public.approve_version(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not me.is_admin then
    raise exception 'Translations are approved by a 2/3 vote – only the admin approves directly.';
  end if;
  select * into v from versions where id = p_id;
  if v.id is null then raise exception 'That version no longer exists.'; end if;
  perform private.decide_version(p_id, true, me.display_name);
end $$;

create or replace function public.reject_version(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not me.is_admin then
    raise exception 'Translations are turned down by vote – only the admin decides directly.';
  end if;
  select * into v from versions where id = p_id;
  if v.id is null or v.status <> 'pending' then raise exception 'That version is no longer waiting.'; end if;
  perform private.decide_version(p_id, false, me.display_name);
end $$;

-- Agree (true), disagree (false) or take my vote back (null). Returns what happened to the version:
-- 'approved', 'rejected', 'open' (still voting) or 'admin' (nobody can vote: the admin decides).
create or replace function public.vote(p_id bigint, p_agree boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not me.can_review or me.is_admin then
    raise exception 'Only people who can vote can vote (the admin approves directly).';
  end if;
  select * into v from versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then raise exception 'That version is no longer waiting.'; end if;
  if private.is_author(v, me.id) then raise exception 'You can''t vote on your own translation.'; end if;
  if p_agree is null then
    delete from votes where version_id = p_id and voter = me.id;
  else
    insert into votes (version_id, line_id, project_id, voter, voter_name, agree)
    values (p_id, v.line_id, v.project_id, me.id, me.display_name, p_agree)
    on conflict (version_id, voter) do update set agree = excluded.agree, created_at = now();
  end if;
  return private.settle_votes(p_id);
end $$;

-- How many lines wait for my vote, per project (for the welcome page and the review tab).
create or replace function public.need_my_vote()
returns table (project_id bigint, lines bigint)
language sql stable security definer set search_path = public as $$
  select v.project_id, count(distinct v.line_id)
  from versions v
  where v.status = 'pending'
    and exists (select 1 from profiles p where p.id = auth.uid() and p.can_review and not p.is_admin)
    and not private.is_author(v, auth.uid())
    and not exists (select 1 from votes x where x.version_id = v.id and x.voter = auth.uid())
  group by v.project_id
$$;

-- get_lines: every version now carries its votes, and p_unvoted picks the lines waiting for my vote.
drop function if exists public.get_lines(bigint, text, text, text, text, bigint[], int, text);
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
                                                                     'agree', x.agree, 'created_at', x.created_at)
                                                  order by x.created_at)
                                 from votes x where x.version_id = v.id), '[]'::jsonb))
                                      order by v.created_at, v.id)
                            from versions v where v.line_id = b.id), '[]'::jsonb),
      'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
                         from notes n where n.line_id = b.id), '[]'::jsonb)
    ) order by b.idx), '[]'::jsonb)
  from picked b
$$;

-- The dashboard counts every vote as a review (and "Team vote" isn't a person).
create or replace function public.people_stats(p_project bigint)
returns table (name text, approved bigint, waiting bigint, not_used bigint, reviewed bigint, notes bigint,
               last_active timestamptz)
language sql stable as $$
  select name, sum(a), sum(w), sum(n_u), sum(r), sum(nt), max(t) from (
    select author_name as name, (status = 'approved')::int as a, (status = 'pending')::int as w,
           (status in ('rejected', 'superseded'))::int as n_u, 0 as r, 0 as nt, created_at as t
      from versions where project_id = p_project
    union all
    select decided_by_name, 0, 0, 0, 1, 0, decided_at from versions
      where project_id = p_project and decided_by_name not in ('Imported', 'Team vote')
    union all
    select voter_name, 0, 0, 0, 1, 0, created_at from votes where project_id = p_project
    union all
    select author_name, 0, 0, 0, 0, 1, created_at from notes where project_id = p_project
  ) x
  group by name
  order by 2 desc, 1
$$;

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
      where project_id = p_project and decided_by_name not in ('Imported', 'Team vote')
    union all
    select voter_name, created_at, 0, 0, 1, 0 from votes where project_id = p_project
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

alter publication supabase_realtime add table public.votes;
