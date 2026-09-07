-- WARNING: This permanently deletes all bot data.
-- Run the entire script once in the Supabase SQL Editor.

begin;

-- Drop children before parents.
drop table if exists order_items cascade;
drop table if exists orders cascade;
drop table if exists products cascade;
drop table if exists payment_methods cascade;
drop table if exists conversations cascade;

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price numeric not null check (price >= 0),
  category text not null default 'general'
    check (category = lower(category)),
  image_url text,
  created_at timestamptz not null default now()
);

create table payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_number text not null,
  account_name text,
  instructions text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_telegram_id bigint not null,
  customer_name text,
  customer_phone text,
  delivery_location text,
  delivery_fee numeric not null default 0,
  subtotal numeric not null default 0,
  total numeric not null default 0,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'pending_verification', 'confirmed', 'rejected')),
  screenshot_url text,
  rejection_reason text,
  reminder_count integer not null default 0,
  payment_method_id uuid references payment_methods(id) on delete set null,
  payment_method_name text,
  payment_account_number text,
  payment_account_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  unit_price numeric not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0)
);

create table conversations (
  chat_id bigint primary key,
  language text not null default 'en' check (language in ('en', 'am')),
  history jsonb not null default '[]'::jsonb,
  cart jsonb not null default '[]'::jsonb,
  pending_order_id uuid references orders(id) on delete set null,
  customer_phone text,
  pending_step text,
  updated_at timestamptz not null default now()
);

-- The bot uses the Supabase service key, which bypasses RLS.
alter table products enable row level security;
alter table payment_methods enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table conversations enable row level security;

create policy "authenticated can read products"
  on products for select using (auth.role() = 'authenticated');
create policy "authenticated can read payment methods"
  on payment_methods for select using (auth.role() = 'authenticated');

create policy "authenticated can read orders"
  on orders for select using (auth.role() = 'authenticated');
create policy "authenticated can read order items"
  on order_items for select using (auth.role() = 'authenticated');

commit;

-- Supabase Storage is separate from SQL. Create these public buckets in
-- Dashboard > Storage, or create them with the service-role API:
--   product-images
--   payment-screenshots
