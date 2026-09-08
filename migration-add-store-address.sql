-- Run this in the Supabase SQL Editor.
-- The bot uses SUPABASE_SERVICE_KEY (service_role), which bypasses RLS.
-- These policies also allow authenticated dashboard users to manage the address.

create table if not exists store_addresses (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  description text,
  image_url text,
  updated_at timestamptz not null default now()
);

alter table store_addresses enable row level security;

create policy "authenticated can read store address"
  on store_addresses for select
  using (auth.role() = 'authenticated');

create policy "authenticated can add store address"
  on store_addresses for insert
  with check (auth.role() = 'authenticated');

create policy "authenticated can update store address"
  on store_addresses for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "authenticated can remove store address"
  on store_addresses for delete
  using (auth.role() = 'authenticated');
