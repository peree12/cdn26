-- =====================================================================
-- CDN 26 · Panel de administración + ranking de Ultimate Team
-- Pégalo completo en Supabase → SQL Editor → New query → Run.
-- Se puede ejecutar más de una vez sin problema.
-- =====================================================================

-- 1) Tabla de administradores
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists "admins_self" on public.admins;
create policy "admins_self" on public.admins for select to authenticated using (user_id = auth.uid());

-- 2) ¿La cuenta que está conectada es administradora? (lo usa el juego para mostrar el panel)
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 3) Partidas guardadas: cada jugador maneja las suyas; los administradores pueden ver y mandar cambios a todos.
--    La fila "admin" (órdenes del administrador) solo la puede escribir un administrador.
drop policy if exists "saves_insert_own" on public.saves;
drop policy if exists "saves_update_own" on public.saves;
create policy "saves_insert_own" on public.saves for insert to authenticated with check (auth.uid() = user_id and slot <> 'admin');
create policy "saves_update_own" on public.saves for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id and slot <> 'admin');
drop policy if exists "saves_admin_select" on public.saves;
drop policy if exists "saves_admin_insert" on public.saves;
drop policy if exists "saves_admin_update" on public.saves;
drop policy if exists "saves_admin_delete" on public.saves;
create policy "saves_admin_select" on public.saves for select to authenticated using (public.is_admin());
create policy "saves_admin_insert" on public.saves for insert to authenticated with check (public.is_admin());
create policy "saves_admin_update" on public.saves for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "saves_admin_delete" on public.saves for delete to authenticated using (public.is_admin());

-- 4) Ranking de Ultimate Team (si no existía, se crea)
create table if not exists public.ut_ranking (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nick text, club text,
  pts int not null default 0, rating int not null default 0,
  w int not null default 0, d int not null default 0, l int not null default 0,
  gf int not null default 0, ga int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ut_ranking enable row level security;
drop policy if exists "rank_select_all" on public.ut_ranking;
drop policy if exists "rank_insert_own" on public.ut_ranking;
drop policy if exists "rank_update_own" on public.ut_ranking;
drop policy if exists "rank_admin_delete" on public.ut_ranking;
create policy "rank_select_all" on public.ut_ranking for select to authenticated using (true);
create policy "rank_insert_own" on public.ut_ranking for insert to authenticated with check (auth.uid() = user_id);
create policy "rank_update_own" on public.ut_ranking for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "rank_admin_delete" on public.ut_ranking for delete to authenticated using (public.is_admin() or auth.uid() = user_id);
grant select, insert, update, delete on public.ut_ranking to authenticated;

-- 5) Lista de jugadores para el panel (solo administradores)
create or replace function public.admin_list_users()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, nick text, coins numeric, club text, ut_updated timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Solo administradores'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at,
      (select s.data->>'nick' from public.saves s where s.user_id = u.id and s.slot = 'profile'),
      (select (s.meta->>'coins')::numeric from public.saves s where s.user_id = u.id and s.slot = 'ut'),
      (select s.meta->>'club' from public.saves s where s.user_id = u.id and s.slot = 'ut'),
      (select s.updated_at from public.saves s where s.user_id = u.id and s.slot = 'ut')
    from auth.users u
    order by u.last_sign_in_at desc nulls last;
end $$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- 6) Administradora: la cuenta "peree.12" (por su correo o por su nombre en el juego)
insert into public.admins (user_id)
  select id from auth.users where lower(split_part(email, '@', 1)) = 'peree.12'
  on conflict do nothing;
insert into public.admins (user_id)
  select user_id from public.saves where slot = 'profile' and lower(data->>'nick') = 'peree.12'
  on conflict do nothing;

-- 7) Revisa quién quedó como administrador (debe aparecer SOLO tu correo)
select a.user_id, u.email, a.created_at from public.admins a join auth.users u on u.id = a.user_id;
