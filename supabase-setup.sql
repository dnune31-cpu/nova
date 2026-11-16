-- Prism + Moo-llion: database setup for Supabase.
-- Run this ONCE in the Supabase dashboard: SQL Editor > New query > paste all of it > Run.
-- It is safe to run again (it only replaces the function and keeps your data).
--
-- What it makes:
--   * one table, "kv", that holds everything the site saves (accounts, chats, game rooms, scores)
--   * one function, "kv(cmds)", that the site's server calls. It understands the small set of
--     Redis-style commands the site already uses (GET, SET, HSET, SADD, ...), so the rest of the
--     code did not have to change. Several commands can be sent in one call.
-- Only the site's server (using the secret service_role key) may call it. Visitors' browsers cannot.

create table if not exists public.kv (
  k   text primary key,
  t   "char" not null default 's',   -- s = text value, h = hash, e = set, l = list, z = sorted set
  v   text,                          -- the value, for type s
  j   jsonb,                         -- the contents, for the other types
  exp timestamptz                    -- when the key expires (null = never)
);
create index if not exists kv_exp on public.kv (exp) where exp is not null;
alter table public.kv enable row level security;   -- no policies: nothing but the server can touch it

create or replace function public.kv(cmds jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  out jsonb := '[]'::jsonb;
  c jsonb; op text; key text; a text[]; n int; i int;
  r jsonb; row_ kv%rowtype; cnt bigint; txt text; ttl interval; nx boolean;
  lo int; hi int; len int;
begin
  if random() < 0.01 then delete from kv where exp is not null and exp <= now(); end if;  -- now and then, sweep out expired keys

  for c in select * from jsonb_array_elements(cmds) loop
    begin
      select array_agg(x order by o) into a from jsonb_array_elements_text(c) with ordinality as e(x, o);
      op := upper(a[1]); key := a[2]; n := coalesce(array_length(a, 1), 0); r := 'null'::jsonb;
      if key is not null and op not in ('SCAN', 'EVAL', 'DEL') then
        delete from kv where k = key and exp is not null and exp <= now();   -- an expired key counts as gone
      end if;

      if op = 'GET' then
        select to_jsonb(v) into r from kv where k = key and t = 's';
        r := coalesce(r, 'null'::jsonb);

      elsif op = 'SET' then
        nx := false; ttl := null; i := 4;
        while i <= n loop
          if upper(a[i]) = 'NX' then nx := true; i := i + 1;
          elsif upper(a[i]) = 'EX' then ttl := make_interval(secs => a[i + 1]::double precision); i := i + 2;
          elsif upper(a[i]) = 'PX' then ttl := make_interval(secs => a[i + 1]::double precision / 1000.0); i := i + 2;
          else i := i + 1; end if;
        end loop;
        if nx then
          insert into kv (k, t, v, j, exp) values (key, 's', a[3], null, now() + ttl) on conflict (k) do nothing;
          get diagnostics cnt = row_count;
          if cnt > 0 then r := '"OK"'::jsonb; end if;
        else
          insert into kv (k, t, v, j, exp) values (key, 's', a[3], null, now() + ttl)
            on conflict (k) do update set t = 's', v = excluded.v, j = null, exp = excluded.exp;
          r := '"OK"'::jsonb;
        end if;

      elsif op = 'DEL' then
        delete from kv where k = any (a[2:n]) and (exp is null or exp > now());
        get diagnostics cnt = row_count;
        delete from kv where k = any (a[2:n]);
        r := to_jsonb(cnt);

      elsif op = 'EXISTS' then
        select count(*) into cnt from kv where k = key;
        r := to_jsonb(cnt);

      elsif op = 'INCR' then
        insert into kv (k, t, v) values (key, 's', '1')
          on conflict (k) do update set v = (coalesce(nullif(kv.v, ''), '0')::bigint + 1)::text
          returning v into txt;
        r := to_jsonb(txt::bigint);

      elsif op = 'EXPIRE' then
        update kv set exp = now() + make_interval(secs => a[3]::double precision) where k = key;
        get diagnostics cnt = row_count; r := to_jsonb(cnt);

      elsif op = 'PERSIST' then
        update kv set exp = null where k = key and exp is not null;
        get diagnostics cnt = row_count; r := to_jsonb(cnt);

      elsif op = 'RENAME' then
        select * into row_ from kv where k = key;
        if not found then raise exception 'ERR no such key'; end if;
        delete from kv where k in (key, a[3]);
        insert into kv (k, t, v, j, exp) values (a[3], row_.t, row_.v, row_.j, row_.exp);
        r := '"OK"'::jsonb;

      -- hashes: j is an object of field -> value
      elsif op = 'HGET' then
        select j -> a[3] into r from kv where k = key and t = 'h';
        r := coalesce(r, 'null'::jsonb);

      elsif op = 'HSET' then
        select count(*) into cnt from kv where k = key and t = 'h' and j ? a[3];
        insert into kv (k, t, j) values (key, 'h', jsonb_build_object(a[3], a[4]))
          on conflict (k) do update set t = 'h', v = null, j = (case when kv.t = 'h' then kv.j else '{}'::jsonb end) || excluded.j;
        r := to_jsonb(1 - cnt);

      elsif op = 'HDEL' then
        select count(*) into cnt from kv where k = key and t = 'h' and j ? a[3];
        update kv set j = j - a[3] where k = key and t = 'h';
        r := to_jsonb(cnt);

      elsif op = 'HKEYS' then
        select coalesce(jsonb_agg(f), '[]'::jsonb) into r from kv, jsonb_object_keys(j) as f where k = key and t = 'h';

      elsif op = 'HGETALL' then
        select coalesce(jsonb_agg(x order by o, p), '[]'::jsonb) into r from (
          select o, 0 as p, to_jsonb(e.f) as x from kv, jsonb_each(j) with ordinality as e(f, val, o) where k = key and t = 'h'
          union all
          select o, 1 as p, e.val as x from kv, jsonb_each(j) with ordinality as e(f, val, o) where k = key and t = 'h'
        ) q;

      -- sets: j is an object of member -> true
      elsif op = 'SADD' then
        select count(*) into cnt from unnest(a[3:n]) as m where not exists (select 1 from kv where k = key and t = 'e' and j ? m);
        insert into kv (k, t, j) values (key, 'e', (select jsonb_object_agg(m, true) from unnest(a[3:n]) as m))
          on conflict (k) do update set t = 'e', v = null, j = (case when kv.t = 'e' then kv.j else '{}'::jsonb end) || excluded.j;
        r := to_jsonb(cnt);

      elsif op = 'SREM' then
        select count(*) into cnt from unnest(a[3:n]) as m where exists (select 1 from kv where k = key and t = 'e' and j ? m);
        update kv set j = j - a[3:n] where k = key and t = 'e';
        r := to_jsonb(cnt);

      elsif op = 'SMEMBERS' then
        select coalesce(jsonb_agg(f), '[]'::jsonb) into r from kv, jsonb_object_keys(j) as f where k = key and t = 'e';

      elsif op = 'SISMEMBER' then
        select count(*) into cnt from kv where k = key and t = 'e' and j ? a[3];
        r := to_jsonb(cnt);

      -- lists: j is an array, newest first for LPUSH
      elsif op = 'LPUSH' then
        insert into kv (k, t, j) values (key, 'l', jsonb_build_array(a[3]))
          on conflict (k) do update set t = 'l', v = null, j = excluded.j || (case when kv.t = 'l' then kv.j else '[]'::jsonb end)
          returning jsonb_array_length(j) into len;
        r := to_jsonb(len);

      elsif op in ('LRANGE', 'LTRIM') then
        select coalesce(jsonb_array_length(j), 0) into len from kv where k = key and t = 'l';
        len := coalesce(len, 0); lo := a[3]::int; hi := a[4]::int;
        if lo < 0 then lo := greatest(len + lo, 0); end if;
        if hi < 0 then hi := len + hi; end if;
        select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into r
          from kv, jsonb_array_elements(j) with ordinality as e(x, o) where k = key and t = 'l' and o - 1 between lo and hi;
        if op = 'LTRIM' then update kv set j = r where k = key and t = 'l'; r := '"OK"'::jsonb; end if;

      -- sorted sets: j is an object of member -> score
      elsif op = 'ZADD' then
        select count(*) into cnt from kv where k = key and t = 'z' and j ? a[4];
        insert into kv (k, t, j) values (key, 'z', jsonb_build_object(a[4], a[3]::double precision))
          on conflict (k) do update set t = 'z', v = null, j = (case when kv.t = 'z' then kv.j else '{}'::jsonb end) || excluded.j;
        r := to_jsonb(1 - cnt);

      elsif op = 'ZREVRANGE' then
        lo := a[3]::int; hi := a[4]::int;
        select coalesce(jsonb_agg(x order by rn, p), '[]'::jsonb) into r from (
          select rn, 0 as p, to_jsonb(m) as x from (select e.f as m, (e.val)::text::double precision as s, row_number() over (order by (e.val)::text::double precision desc, e.f desc) as rn
            from kv, jsonb_each(j) as e(f, val) where k = key and t = 'z') z where rn - 1 between lo and (case when hi < 0 then 2147483647 else hi end)
          union all
          select rn, 1 as p, to_jsonb(s::text) as x from (select e.f as m, (e.val)::text::double precision as s, row_number() over (order by (e.val)::text::double precision desc, e.f desc) as rn
            from kv, jsonb_each(j) as e(f, val) where k = key and t = 'z') z
            where rn - 1 between lo and (case when hi < 0 then 2147483647 else hi end) and upper(coalesce(a[5], '')) = 'WITHSCORES'
        ) q;

      -- SCAN cursor [MATCH pattern] [COUNT n]: returns every matching key in one go, so the cursor that comes back is always "0"
      elsif op = 'SCAN' then
        txt := '%';
        i := 3;
        while i <= n loop
          if upper(a[i]) = 'MATCH' then txt := replace(replace(replace(replace(a[i + 1], '\', '\\'), '%', '\%'), '_', '\_'), '*', '%'); end if;
          i := i + 2;
        end loop;
        select jsonb_build_array('0', coalesce(jsonb_agg(k), '[]'::jsonb)) into r from kv where k like txt escape '\' and (exp is null or exp > now());

      -- EVAL is only used for one thing: "delete this key if it still holds my token" (releasing a lock)
      elsif op = 'EVAL' then
        delete from kv where k = a[4] and t = 's' and v = a[5] and (exp is null or exp > now());
        get diagnostics cnt = row_count; r := to_jsonb(cnt);

      else
        raise exception 'ERR unknown command %', op;
      end if;

      out := out || jsonb_build_array(jsonb_build_object('result', r));
    exception when others then
      out := out || jsonb_build_array(jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return out;
end;
$$;

-- only the server's secret key may call it
revoke all on function public.kv(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.kv(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.kv(jsonb) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.kv(jsonb) to service_role; end if;
end $$;
