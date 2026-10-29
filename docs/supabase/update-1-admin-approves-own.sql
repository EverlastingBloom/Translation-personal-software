-- Update 1: the admin may approve (and turn down) their own translations.
-- Only for a database set up before this change: Supabase -> SQL Editor -> New query -> paste -> Run.

-- Approving: only reviewers and the admin. Reviewers never approve their own translation;
-- the admin may.
create or replace function public.approve_version(p_id bigint) returns void
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

create or replace function public.reject_version(p_id bigint) returns void
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
