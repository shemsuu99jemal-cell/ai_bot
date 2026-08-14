alter table products enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

create policy "authenticated can read products" on products for select using (auth.role() = 'authenticated');
create policy "authenticated can write products" on products for insert with check (auth.role() = 'authenticated');
create policy "authenticated can update products" on products for update using (auth.role() = 'authenticated');
create policy "authenticated can delete products" on products for delete using (auth.role() = 'authenticated');

create policy "authenticated can read orders" on orders for select using (auth.role() = 'authenticated');
create policy "authenticated can update orders" on orders for update using (auth.role() = 'authenticated');

create policy "authenticated can read order_items" on order_items for select using (auth.role() = 'authenticated');
