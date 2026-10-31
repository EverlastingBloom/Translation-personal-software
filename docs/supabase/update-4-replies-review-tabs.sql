-- Update 4: replies in messages, and the review list per person.
-- Only for a database set up before this change (after update 3):
-- Supabase -> SQL Editor -> New query -> paste -> Run.

alter table public.messages add column reply_to bigint references public.messages on delete set null;

-- The sender and the time always come from the account, so nobody can write as someone else.
-- A reply can only answer a message of the same conversation.
create or replace function public.stamp_message() returns trigger
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

-- get_lines gets a new last argument (p_author), so the old one has to go first.
drop function if exists public.get_lines(bigint, text, text, text, text, bigint[], int);
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
create or replace function public.review_queue(p_project bigint)
returns table (name text, waiting bigint, lines bigint, oldest timestamptz)
language sql stable as $$
  select author_name, count(*), count(distinct line_id), min(created_at)
  from versions
  where project_id = p_project and status = 'pending'
  group by author_name
  order by 2 desc, 1
$$;
