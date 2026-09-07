-- Run this in Supabase SQL Editor if your database already has products table
-- without the description column.

alter table products
  add column if not exists description text;

update products
set description = coalesce(nullif(btrim(description), ''), null)
where description is null or btrim(description) = '';
