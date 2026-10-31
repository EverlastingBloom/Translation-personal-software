-- Update 6: the admin can switch their admin powers off, and translate and vote like everyone else.
-- Only for a database set up before this change (after update 5):
-- Supabase -> SQL Editor -> New query -> paste -> Run.

alter table public.profiles add column admin_active boolean not null default true;

-- The admin switches their admin powers off (and acts as a normal translator and voter) or on again.
create or replace function public.set_admin_power(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    raise exception 'Only the admin has admin powers to switch.';
  end if;
  update profiles set admin_active = p_on where id = auth.uid();
end $$;

-- is_admin() (behind every admin rule) is only true while the admin's powers are on.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and is_admin and admin_active) $$;

-- Who may vote on a version: everyone who "can vote" (an admin with powers off too), except an
-- acting admin and the author.
-- Approved once agree >= ceil(2/3 of them); turned down once 2/3 can't be reached any more.
create or replace function private.settle_votes(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare v versions; pool int; need int; yes int; no int;
begin
  select * into v from versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then return 'decided'; end if;
  select count(*) into pool from profiles p
    where (p.can_review or p.is_admin) and not (p.is_admin and p.admin_active) and not private.is_author(v, p.id);
  if pool = 0 then return 'admin'; end if;
  need := ceil(pool * 2 / 3.0);
  select count(*) filter (where x.agree), count(*) filter (where not x.agree) into yes, no
    from votes x join profiles p on p.id = x.voter
    where x.version_id = p_id and (p.can_review or p.is_admin) and not (p.is_admin and p.admin_active) and not private.is_author(v, p.id);
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
  if me.id is null or not (me.is_admin and me.admin_active) then
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
  if me.id is null or not (me.is_admin and me.admin_active) then
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
  if me.id is null or not (me.can_review or me.is_admin) or (me.is_admin and me.admin_active) then
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
    and exists (select 1 from profiles p where p.id = auth.uid() and (p.can_review or p.is_admin) and not (p.is_admin and p.admin_active))
    and not private.is_author(v, auth.uid())
    and not exists (select 1 from votes x where x.version_id = v.id and x.voter = auth.uid())
  group by v.project_id
$$;
