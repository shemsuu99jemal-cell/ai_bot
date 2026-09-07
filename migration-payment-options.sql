-- Run once in the Supabase SQL editor.
create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_number text not null,
  account_name text,
  instructions text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table orders add column if not exists payment_method_id uuid;
alter table orders add column if not exists payment_method_name text;
alter table orders add column if not exists payment_account_number text;
alter table orders add column if not exists payment_account_name text;

alter table payment_methods enable row level security;
drop policy if exists "service role manages payment methods" on payment_methods;
create policy "service role manages payment methods"
  on payment_methods for all using (auth.role() = 'service_role');

insert into payment_methods (name, account_number, account_name)
select 'Telebirr', '0911477218', 'Abdulsemed Abdulshukur'
where not exists (select 1 from payment_methods where lower(name) = 'telebirr');