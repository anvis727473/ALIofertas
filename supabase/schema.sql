-- Execute este SQL no painel do Supabase (SQL Editor)

CREATE TABLE IF NOT EXISTS deals (
  id BIGSERIAL PRIMARY KEY,
  product_id VARCHAR NOT NULL,
  title TEXT NOT NULL,
  price NUMERIC(10,2),
  currency VARCHAR(10) DEFAULT 'USD',
  image_url TEXT,
  product_url TEXT,
  affiliate_link TEXT,
  rating NUMERIC(3,2),
  orders INTEGER DEFAULT 0,
  posted_to BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_users (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT UNIQUE NOT NULL,
  username VARCHAR,
  first_name VARCHAR,
  last_searched TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_product_id ON deals(product_id);
CREATE INDEX IF NOT EXISTS idx_deals_posted_to ON deals(posted_to);
CREATE INDEX IF NOT EXISTS idx_bot_users_chat_id ON bot_users(chat_id);

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on deals" ON deals
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on bot_users" ON bot_users
  FOR ALL USING (true) WITH CHECK (true);
