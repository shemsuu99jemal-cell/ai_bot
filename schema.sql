-- Run this in Supabase SQL Editor. If you already ran the earlier schema.sql,
-- drop the old single-item `orders` table first (or run in a fresh project) —
-- this version splits orders into a header + line items to support carts.

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price numeric not null,
  stock int default 0,
  category text,
  color text,
  colors text[] default array[]::text[],
  image_url text,
  created_at timestamptz default now()
);

create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_number text not null,
  account_name text,
  instructions text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_telegram_id bigint not null,
  customer_name text,
  customer_phone text,
  delivery_location text,
  delivery_fee numeric default 0,
  subtotal numeric,
  total numeric not null default 0,
  status text default 'awaiting_payment',
  -- awaiting_payment -> pending_verification -> confirmed / rejected
  screenshot_url text,
  rejection_reason text,
  reminder_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table orders add column if not exists payment_method_id uuid;
alter table orders add column if not exists payment_method_name text;
alter table orders add column if not exists payment_account_number text;
alter table orders add column if not exists payment_account_name text;

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  product_name text not null,     -- snapshot, in case product is edited/deleted later
  unit_price numeric not null,    -- snapshot of price at order time
  quantity int not null
);

-- Conversation state, persisted so a bot restart doesn't lose context or the cart
create table if not exists conversations (
  chat_id bigint primary key,
  language text default 'en',        -- 'en' or 'am'
  history jsonb default '[]',
  cart jsonb default '[]',           -- [{ product_id, name, price, quantity }]
  pending_order_id uuid,             -- set after checkout, cleared once screenshot is attached
  customer_phone text,
  delivery_location text,
  delivery_fee numeric default 0,
  pending_step text,
  updated_at timestamptz default now()
);

-- Storage bucket for payment screenshots (create via Supabase Dashboard > Storage)
-- Bucket name: payment-screenshots (set to public, or use signed URLs)

-- seed test products
insert into products (name, description, price, stock, category, color, colors) values
  ('iPhone 13 128GB', 'Used, good condition, unlocked', 22000, 3, 'Phones', 'Black', ARRAY['Black', 'White', 'Blue']),
  ('Samsung A54', 'New, sealed box', 15000, 5, 'Phones', 'Awesome Black', ARRAY['Awesome Black', 'White', 'Green']),
  ('Fast charger 20W', 'Original Apple/Samsung compatible', 800, 20, 'Accessories', 'White', ARRAY['White', 'Black']);

-- additional seed products (idempotent by product name)
insert into products (name, description, price, stock, category, color, colors)
select p.name, p.description, p.price, p.stock, p.category, p.color, p.colors
from (
  values
    ('iPad 9th Gen 64GB', 'Wi-Fi, excellent condition', 26000, 4, 'Tablets', 'Space Gray', ARRAY['Space Gray', 'Silver']::text[]),
    ('iPad Air 5 256GB', 'M1 chip, smooth performance', 52000, 2, 'Tablets', 'Blue', ARRAY['Blue', 'Starlight', 'Gray']::text[]),
    ('Samsung Galaxy Tab A9', '8.7-inch display, LTE ready', 14500, 6, 'Tablets', 'Graphite', ARRAY['Graphite', 'Silver']::text[]),
    ('Samsung Galaxy Tab S9 FE', 'S Pen included, 128GB', 36000, 3, 'Tablets', 'Mint', ARRAY['Mint', 'Gray', 'Lavender']::text[]),
    ('Lenovo Tab M10 Plus', '10.6-inch, family tablet', 16500, 5, 'Tablets', 'Storm Gray', ARRAY['Storm Gray']::text[]),
    ('Xiaomi Redmi Pad SE', '11-inch FHD+, 8000mAh battery', 17000, 5, 'Tablets', 'Gray', ARRAY['Gray', 'Mint', 'Purple']::text[]),

    ('Dell Latitude 5420', 'Core i5 11th Gen, 16GB RAM, 512GB SSD', 48000, 4, 'Computers', 'Black', ARRAY['Black']::text[]),
    ('HP EliteBook 840 G8', 'Core i7, 16GB RAM, business laptop', 62000, 3, 'Computers', 'Silver', ARRAY['Silver']::text[]),
    ('Lenovo ThinkPad T14', 'Durable business laptop, 14-inch', 59000, 3, 'Computers', 'Black', ARRAY['Black']::text[]),
    ('Acer Aspire 5', 'Core i5, 8GB RAM, 512GB SSD', 39000, 6, 'Computers', 'Gray', ARRAY['Gray']::text[]),
    ('ASUS VivoBook 15', 'Core i5, lightweight daily laptop', 36500, 5, 'Computers', 'Indie Black', ARRAY['Indie Black', 'Silver']::text[]),
    ('MacBook Air M1 256GB', 'Apple M1, all-day battery', 76000, 2, 'Computers', 'Space Gray', ARRAY['Space Gray', 'Silver', 'Gold']::text[]),

    ('JBL Tune 760NC', 'Wireless headphones with ANC', 6500, 10, 'Audio', 'Black', ARRAY['Black', 'Blue']::text[]),
    ('Anker Soundcore R50i', 'True wireless earbuds, deep bass', 2900, 14, 'Audio', 'Black', ARRAY['Black', 'White']::text[]),
    ('Sony WH-CH520', 'Bluetooth on-ear headphones', 5200, 8, 'Audio', 'Blue', ARRAY['Blue', 'Black', 'White']::text[]),

    ('Samsung Galaxy Watch 6', 'Smartwatch, fitness and notifications', 16500, 4, 'Wearables', 'Graphite', ARRAY['Graphite', 'Silver']::text[]),
    ('Apple Watch SE 44mm', 'GPS model, great for daily tracking', 23500, 3, 'Wearables', 'Midnight', ARRAY['Midnight', 'Starlight']::text[]),
    ('Xiaomi Smart Band 8', 'Affordable fitness band', 2400, 15, 'Wearables', 'Black', ARRAY['Black', 'Gold']::text[]),

    ('Mi Box S 2nd Gen', '4K Android TV streaming box', 5800, 7, 'Home Electronics', 'Black', ARRAY['Black']::text[]),
    ('Google Chromecast HD', 'Smart streaming device with remote', 4300, 9, 'Home Electronics', 'Snow', ARRAY['Snow']::text[]),
    ('TP-Link Archer C6 Router', 'Dual-band Wi-Fi router', 3600, 10, 'Networking', 'Black', ARRAY['Black']::text[]),
    ('Huawei B535 4G Router', '4G LTE home internet router', 8900, 5, 'Networking', 'White', ARRAY['White']::text[]),
    ('Seagate 1TB External HDD', 'Portable USB 3.0 storage', 4200, 12, 'Storage', 'Black', ARRAY['Black']::text[]),
    ('SanDisk 256GB USB 3.2', 'High-speed flash drive', 1700, 18, 'Storage', 'Black', ARRAY['Black']::text[])
) as p(name, description, price, stock, category, color, colors)
where not exists (
  select 1 from products existing where lower(existing.name) = lower(p.name)
);
