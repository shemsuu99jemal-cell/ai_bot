-- Run this in Supabase SQL Editor if you already created schema-reset.sql
-- before category and stock were added.

alter table products
  add column if not exists category text;

update products
set category = coalesce(nullif(lower(btrim(category)), ''), 'general');

update products
set category = lower(btrim(category));

alter table products
  alter column category set default 'general',
  alter column category set not null;

alter table products
  drop constraint if exists products_category_lowercase;

alter table products
  add constraint products_category_lowercase
  check (category = lower(category));