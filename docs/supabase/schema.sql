-- Team Translation website: the database.
-- Run this ONCE in Supabase → SQL Editor → New query → paste → Run.
-- Before running, put YOUR email and name on the line marked "ADMIN" at the very bottom.

-- ---------------------------------------------------------------------------------------------
-- Who may use the site. Only emails on this list can create an account (invite only).
create table public.invites (
  email        text primary key check (email = lower(email)),
  display_name text not null,
  is_admin     boolean not null default false,
  can_review   boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Everyone with an account. Removing someone here takes their access away at once.
create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text not null,
  display_name text not null,
  is_admin     boolean not null default false,
  admin_active boolean not null default true,  -- the admin can switch their admin powers off
  can_review   boolean not null default true,
  created_at   timestamptz not null default now()
);

-- A game file being translated. Everything needed to write the file back is kept.
create table public.projects (
  id               bigint generated always as identity primary key,
  name             text not null,
  file_name        text not null,
  header           jsonb not null,             -- column names, in file order
  header_raw       text,                       -- the header line exactly as it was (null: column added)
  target_col       int not null,               -- index of the translation column
  cols             jsonb not null,             -- role -> column name: source, key, group, scene, speaker, reference
  delimiter        text not null default ',',
  newline          text not null default E'\r\n',
  bom              boolean not null default false,
  trailing_newline boolean not null default true,
  tag_pattern      text not null default '',
  target_label     text not null default 'Translation',
  created_at       timestamptz not null default now()
);

-- One row of the game file.
create table public.lines (
  id         bigint generated always as identity primary key,
  project_id bigint not null references public.projects on delete cascade,
  idx        int not null,                     -- position in the file
  key        text not null default '',
  grp        text not null default '',
  scene      text not null default '',
  speaker    text not null default '',
  source     text not null,
  reference  text not null default '',
  cells      jsonb not null,                   -- every cell of the original row
  raw        text,                             -- the row exactly as it was in the file
  unique (project_id, idx)
);
create index lines_scene on public.lines (project_id, grp, scene, idx);

-- Every translation anyone writes. It stays "pending" until someone else approves it; the one
-- "approved" version per line is the main translation. Nothing is ever overwritten: this is the
-- full history of who wrote what, and who approved it.
create table public.versions (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references public.projects on delete cascade,
  line_id         bigint not null references public.lines on delete cascade,
  text            text not null,
  author          uuid references public.profiles on delete set null default auth.uid(),
  author_name     text not null default '',
  imported        boolean not null default false,
  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'superseded')),
  created_at      timestamptz not null default now(),
  decided_by_name text,
  decided_at      timestamptz
);
create index versions_line on public.versions (line_id);
create index versions_project on public.versions (project_id, status);
create unique index versions_one_main on public.versions (line_id) where status = 'approved';

-- Notes on a line: a little conversation, oldest first.
create table public.notes (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references public.projects on delete cascade,
  line_id     bigint not null references public.lines on delete cascade,
  body        text not null check (length(body) between 1 and 4000),
  author      uuid references public.profiles on delete set null default auth.uid(),
  author_name text not null default '',
  imported    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index notes_line on public.notes (line_id);

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

-- "I'm working on this scene" - a sign for the others, not a lock.
create table public.claims (
  project_id bigint not null references public.projects on delete cascade,
  grp        text not null,
  scene      text not null,
  user_id    uuid not null references public.profiles on delete cascade default auth.uid(),
  user_name  text not null default '',
  created_at timestamptz not null default now(),
  primary key (project_id, grp, scene, user_id)
);

-- Direct messages between two people on the team. Only those two can read them.
create table public.messages (
  id          bigint generated always as identity primary key,
  sender      uuid not null references public.profiles on delete cascade default auth.uid(),
  sender_name text not null default '',
  recipient   uuid not null references public.profiles on delete cascade,
  body        text not null check (length(body) between 1 and 4000),
  reply_to    bigint references public.messages on delete set null,  -- the message this one answers
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index messages_recipient on public.messages (recipient, created_at);
create index messages_sender on public.messages (sender, created_at);

-- ---------------------------------------------------------------------------------------------
-- Who is asking?
create function public.is_member() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid()) $$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and is_admin and admin_active) $$;

create function public.can_review() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and (can_review or is_admin)) $$;

-- The admin switches their admin powers off (and acts as a normal translator and voter) or on again.
create function public.set_admin_power(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    raise exception 'Only the admin has admin powers to switch.';
  end if;
  update profiles set admin_active = p_on where id = auth.uid();
end $$;

-- A new account: refused unless the email was invited.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv invites;
begin
  select * into inv from invites where email = lower(new.email);
  if inv.email is null then
    raise exception 'NOT_INVITED: % has not been invited', new.email;
  end if;
  insert into profiles (id, email, display_name, is_admin, can_review)
  values (new.id, lower(new.email), inv.display_name, inv.is_admin, inv.can_review);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Names on versions and notes always come from the account, so nobody can write as someone else.
-- Only the admin's import may keep the names from the old files.
create function public.stamp_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (new.imported and is_admin()) then
    new.author := auth.uid();
    new.author_name := coalesce((select display_name from profiles where id = auth.uid()), '');
    new.imported := false;
    new.created_at := now();
  end if;
  return new;
end $$;
create trigger stamp_versions before insert on public.versions
  for each row execute function public.stamp_author();
create trigger stamp_notes before insert on public.notes
  for each row execute function public.stamp_author();

create function public.stamp_claim() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.user_name := coalesce((select display_name from profiles where id = auth.uid()), '');
  return new;
end $$;
create trigger stamp_claims before insert on public.claims
  for each row execute function public.stamp_claim();

-- The sender and the time always come from the account, so nobody can write as someone else.
-- A reply can only answer a message of the same conversation.
create function public.stamp_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.sender := auth.uid();
  new.sender_name := coalesce((select display_name from profiles where id = auth.uid()), '');
  new.created_at := now();
  new.read_at := null;
  if new.reply_to is not null and not exists (
      select 1 from messages m where m.id = new.reply_to
        and ((m.sender = new.sender and m.recipient = new.recipient)
             or (m.sender = new.recipient and m.recipient = new.sender))) then
    new.reply_to := null;
  end if;
  return new;
end $$;
create trigger stamp_messages before insert on public.messages
  for each row execute function public.stamp_message();

-- Changing the words of a suggestion clears its votes: they were for the old words.
create function public.reset_votes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.text is distinct from old.text then delete from votes where version_id = new.id; end if;
  return new;
end $$;
create trigger reset_votes after update of text on public.versions
  for each row execute function public.reset_votes();

-- ---------------------------------------------------------------------------------------------
-- The rules. Without an account on the team you can't read or change anything.
alter table public.invites  enable row level security;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.lines    enable row level security;
alter table public.versions enable row level security;
alter table public.notes    enable row level security;
alter table public.claims   enable row level security;
alter table public.messages enable row level security;

create policy "admin manages invites" on public.invites for all using (is_admin()) with check (is_admin());

create policy "team sees the team" on public.profiles for select using (is_member());
create policy "admin changes roles" on public.profiles for update using (is_admin()) with check (is_admin());
create policy "admin removes people" on public.profiles for delete using (is_admin() and id <> auth.uid());

create policy "team reads projects" on public.projects for select using (is_member());
create policy "admin writes projects" on public.projects for all using (is_admin()) with check (is_admin());

create policy "team reads lines" on public.lines for select using (is_member());
create policy "admin writes lines" on public.lines for all using (is_admin()) with check (is_admin());

create policy "team reads versions" on public.versions for select using (is_member());
create policy "team suggests" on public.versions for insert
  with check (is_member() and (status = 'pending' or is_admin()));
create policy "change own suggestion" on public.versions for update
  using (author = auth.uid() and status = 'pending') with check (author = auth.uid() and status = 'pending');
create policy "withdraw own suggestion" on public.versions for delete
  using ((author = auth.uid() and status = 'pending') or is_admin());

create policy "team reads notes" on public.notes for select using (is_member());
create policy "team writes notes" on public.notes for insert with check (is_member());
create policy "delete own note" on public.notes for delete using (author = auth.uid() or is_admin());

create policy "team reads claims" on public.claims for select using (is_member());
create policy "team claims" on public.claims for insert with check (is_member());
create policy "unclaim own" on public.claims for delete using (user_id = auth.uid());

create policy "read own messages" on public.messages for select
  using (is_member() and auth.uid() in (sender, recipient));
create policy "write to a teammate" on public.messages for insert
  with check (is_member() and sender = auth.uid() and recipient <> auth.uid());

alter table public.votes enable row level security;
create policy "team reads votes" on public.votes for select using (is_member());
-- no insert/update/delete rules: voting only goes through vote() below

-- ---------------------------------------------------------------------------------------------
-- Approving: by a 2/3 vote of the people who can vote, or directly by the admin.
-- Helpers the page can't call (the private schema isn't reachable from the website).
create schema if not exists private;
revoke all on schema private from public;

-- Did this person write that version? Imported versions only know the author's name.
create function private.is_author(v public.versions, p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when v.imported
              then lower(v.author_name) = lower(coalesce((select display_name from profiles where id = p), ''))
              else coalesce(v.author = p, false) end
$$;

-- Make a version the main translation (the other waiting ones are turned down), or turn it down.
create function private.decide_version(p_id bigint, p_approve boolean, p_by text) returns void
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

-- Who may vote on a version: everyone who "can vote" (an admin with powers off too), except an
-- acting admin and the author.
-- Approved once agree >= ceil(2/3 of them); turned down once 2/3 can't be reached any more.
create function private.settle_votes(p_id bigint) returns text
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
create function public.approve_version(p_id bigint) returns void
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

create function public.reject_version(p_id bigint) returns void
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
create function public.vote(p_id bigint, p_agree boolean) returns text
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
create function public.need_my_vote()
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

-- Opening a conversation marks what that person sent me as read (nothing else can change).
create function public.mark_read(p_from uuid) returns void
language sql security definer set search_path = public as $$
  update messages set read_at = now() where recipient = auth.uid() and sender = p_from and read_at is null
$$;

-- ---------------------------------------------------------------------------------------------
-- Reading, for the pages. These run with the reader's own rights, so the rules above apply.

-- Progress per scene: done (approved, nothing waiting), waiting for review, untranslated.
create function public.scene_stats(p_project bigint)
returns table (grp text, scene text, first_idx int, total bigint, done bigint, review bigint, untranslated bigint)
language sql stable as $$
  with v as (
    select line_id, bool_or(status = 'approved') as a, bool_or(status = 'pending') as p
    from versions where project_id = p_project group by line_id)
  select l.grp, l.scene, min(l.idx), count(*),
         count(*) filter (where v.a and not v.p),
         count(*) filter (where v.p),
         count(*) filter (where v.line_id is null or not (v.a or v.p))
  from lines l left join v on v.line_id = l.id
  where l.project_id = p_project
  group by l.grp, l.scene
  order by min(l.idx)
$$;

-- Progress of every project at once, for the welcome page.
create function public.project_progress()
returns table (project_id bigint, total bigint, done bigint, review bigint, untranslated bigint)
language sql stable as $$
  with v as (
    select line_id, bool_or(status = 'approved') as a, bool_or(status = 'pending') as p
    from versions group by line_id)
  select l.project_id, count(*),
         count(*) filter (where v.a and not v.p),
         count(*) filter (where v.p),
         count(*) filter (where v.line_id is null or not (v.a or v.p))
  from lines l left join v on v.line_id = l.id
  group by l.project_id
$$;

-- Lines with their versions (each with its votes) and notes: one scene, a search, a state, given
-- lines, one person's waiting lines (p_author), or the lines waiting for my vote (p_unvoted).
create function public.get_lines(p_project bigint, p_grp text default null, p_scene text default null,
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

-- Who is waiting for review: one row per person with translations waiting, most first.
create function public.review_queue(p_project bigint)
returns table (name text, waiting bigint, lines bigint, oldest timestamptz)
language sql stable as $$
  select author_name, count(*), count(distinct line_id), min(created_at)
  from versions
  where project_id = p_project and status = 'pending'
  group by author_name
  order by 2 desc, 1
$$;

-- Who did how much: everything so far, and when each person was last active. Reviews count every
-- decision made by a person (also on imported lines) and every vote; never the import or "Team vote".
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
      where project_id = p_project and decided_by_name not in ('Imported', 'Team vote')
    union all
    select voter_name, 0, 0, 0, 1, 0, created_at from votes where project_id = p_project
    union all
    select author_name, 0, 0, 0, 0, 1, created_at from notes where project_id = p_project
  ) x
  group by name
  order by 2 desc, 1
$$;

-- Week by week (a week starts on Monday, in the reader's time zone): what each person did.
-- written = new versions, approved = their versions approved that week, reviewed = versions they
-- decided on or voted on, notes = notes written. Imports without a known author don't count.
create function public.weekly_activity(p_project bigint, p_weeks int default 12, p_tz text default 'UTC')
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

-- Lines that had an approved translation at the end of each week (the progress chart).
create function public.weekly_progress(p_project bigint, p_weeks int default 12, p_tz text default 'UTC')
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
create function public.week_scenes(p_project bigint, p_week date, p_tz text default 'UTC',
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

-- Live updates on everyone's screen.
alter publication supabase_realtime add table public.versions, public.notes, public.claims, public.messages, public.votes;

-- ---------------------------------------------------------------------------------------------
-- ADMIN: your email (lower case) and the name the team sees. Change both, then press Run.
insert into public.invites (email, display_name, is_admin, can_review)
values ('your-email@example.com', 'David', true, true);
