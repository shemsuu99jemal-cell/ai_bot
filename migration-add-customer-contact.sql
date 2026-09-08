alter table conversations add column if not exists customer_phone text;
alter table conversations add column if not exists delivery_location text;
alter table conversations add column if not exists delivery_fee numeric default 0;
alter table conversations add column if not exists pending_step text;

-- The bot uses SUPABASE_SERVICE_KEY, so it can still read/write this table.
-- No public policies are added because conversations contains private customer data.
alter table conversations enable row level security;