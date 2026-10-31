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
$$ select exists (select 1 from profiles where id = auth.uid() and is_admin) $$;

create function public.can_review() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and (can_review or is_admin)) $$;

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

-- ---------------------------------------------------------------------------------------------
-- Approving: only reviewers and the admin. Reviewers never approve their own translation;
-- the admin may.
create function public.approve_version(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not (me.can_review or me.is_admin) then
    raise exception 'Only reviewers can approve.';
  end if;
  select * into v from versions where id = p_id for update;
  if v.id is null then raise exception 'That version no longer exists.'; end if;
  if not me.is_admin and ((not v.imported and v.author = me.id)
                          or (v.imported and lower(v.author_name) = lower(me.display_name))) then
    raise exception 'You can''t approve your own translation – someone else has to check it.';
  end if;
  update versions set status = 'superseded' where line_id = v.line_id and status = 'approved';
  update versions set status = 'rejected', decided_by_name = me.display_name, decided_at = now()
    where line_id = v.line_id and status = 'pending' and id <> v.id;
  update versions set status = 'approved', decided_by_name = me.display_name, decided_at = now()
    where id = v.id;
end $$;

create function public.reject_version(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v versions; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or not (me.can_review or me.is_admin) then
    raise exception 'Only reviewers can turn a translation down.';
  end if;
  select * into v from versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then raise exception 'That version is no longer waiting.'; end if;
  if not me.is_admin and ((not v.imported and v.author = me.id)
                          or (v.imported and lower(v.author_name) = lower(me.display_name))) then
    raise exception 'That''s your own – use Withdraw instead.';
  end if;
  update versions set status = 'rejected', decided_by_name = me.display_name, decided_at = now() where id = v.id;
end $$;

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

-- Lines with their versions and notes: one scene, a search, a state, given lines, or the lines
-- where one person's translation is waiting for review.
create function public.get_lines(p_project bigint, p_grp text default null, p_scene text default null,
                                 p_state text default null, p_search text default null,
                                 p_ids bigint[] default null, p_limit int default 1000,
                                 p_author text default null)
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
      'versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.id)
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

-- Who did how much: everything so far, and when each person was last active.
-- Reviews count every decision made by a person (also on imported lines), never the import itself.
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
alter publication supabase_realtime add table public.versions, public.notes, public.claims, public.messages;

-- ---------------------------------------------------------------------------------------------
-- ADMIN: your email (lower case) and the name the team sees. Change both, then press Run.
insert into public.invites (email, display_name, is_admin, can_review)
values ('your-email@example.com', 'David', true, true);
