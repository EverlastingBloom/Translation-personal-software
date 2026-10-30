-- Update 3: the welcome page and direct messages.
-- Only for a database set up before this change: Supabase -> SQL Editor -> New query -> paste -> Run.

-- Direct messages between two people on the team. Only those two can read them.
create table public.messages (
  id          bigint generated always as identity primary key,
  sender      uuid not null references public.profiles on delete cascade default auth.uid(),
  sender_name text not null default '',
  recipient   uuid not null references public.profiles on delete cascade,
  body        text not null check (length(body) between 1 and 4000),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index messages_recipient on public.messages (recipient, created_at);
create index messages_sender on public.messages (sender, created_at);

-- The sender and the time always come from the account, so nobody can write as someone else.
create function public.stamp_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.sender := auth.uid();
  new.sender_name := coalesce((select display_name from profiles where id = auth.uid()), '');
  new.created_at := now();
  new.read_at := null;
  return new;
end $$;
create trigger stamp_messages before insert on public.messages
  for each row execute function public.stamp_message();

alter table public.messages enable row level security;
create policy "read own messages" on public.messages for select
  using (is_member() and auth.uid() in (sender, recipient));
create policy "write to a teammate" on public.messages for insert
  with check (is_member() and sender = auth.uid() and recipient <> auth.uid());

-- Opening a conversation marks what that person sent me as read (nothing else can change).
create function public.mark_read(p_from uuid) returns void
language sql security definer set search_path = public as $$
  update messages set read_at = now() where recipient = auth.uid() and sender = p_from and read_at is null
$$;

alter publication supabase_realtime add table public.messages;

-- Progress of every project at once, for the welcome page.
create or replace function public.project_progress()
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
