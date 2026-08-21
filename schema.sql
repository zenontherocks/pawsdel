-- Paws Delivered Marketplace - D1 Database Schema
-- Listings are imported from pbtmarketplace.com via the sync cron.
-- No user accounts; buyers check out with contact/shipping info only.
-- Payment is CashApp-only for now, confirmed MANUALLY by an admin (CashApp
-- has no API to verify an individual payment landed). orders.payment_method
-- plus the generic `settings` table are the extension points for adding
-- other payment methods (e.g. PayPal) later without a schema redesign.
--
-- Only scrape/store the approved listing fields: photos, age (via
-- date_of_birth), weight, sex, breed, registry, vaccinations, worming, and
-- price. Never add description, health_info, microchip_id, or sire/dam
-- columns back in without an explicit requirements change.
--
-- Safe to re-run: all statements use IF NOT EXISTS / INSERT OR IGNORE.

CREATE TABLE IF NOT EXISTS pets (
  id             TEXT PRIMARY KEY,
  pbt_id         TEXT NOT NULL UNIQUE,          -- pbtmarketplace.com listing ID (dedup key)
  pbt_url        TEXT NOT NULL,                 -- full URL on PBT (internal use only, never exposed publicly)
  name           TEXT NOT NULL,
  species        TEXT NOT NULL,                 -- 'dog' | 'cat' (keyword-sniffed at scrape time)
  breed          TEXT,
  date_of_birth  TEXT,                          -- ISO 8601, computed from PBT age string at sync time
  weight_lbs     REAL,
  gender         TEXT CHECK(gender IN ('male', 'female', 'unknown')),
  color          TEXT,
  vaccinations   TEXT,                          -- "Name (date)" lines, joined with \n
  worming        TEXT,                          -- same format, deworming records
  registry_name  TEXT,
  price_usd      REAL NOT NULL,                 -- PBT buy-now price
  pbt_seller     TEXT,                          -- PBT seller username (lowercased), for blacklist matching
  status         TEXT NOT NULL DEFAULT 'available'
                 CHECK(status IN ('available', 'pending', 'sold', 'ended')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pet pictures: one pet can have many photos; one is flagged as primary.
-- url stores PBT S3 URLs directly (public CDN, hotlinked, never proxied).
CREATE TABLE IF NOT EXISTS pet_pictures (
  id         TEXT PRIMARY KEY,
  pet_id     TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders: buyer submits contact/shipping info and is shown CashApp payment
-- instructions. Confirmation is manual: marked_paid_at is the buyer's own
-- "I've sent payment" acknowledgement and never flips status by itself;
-- only an admin's confirm sets paid_at + status='paid'.
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  pet_id         TEXT NOT NULL REFERENCES pets(id),
  payment_method TEXT NOT NULL DEFAULT 'cashapp',  -- no CHECK constraint: leaves room for 'paypal' etc.
                                                    -- later with no migration
  amount_usd     REAL NOT NULL,
  payment_ref    TEXT NOT NULL,                 -- short code buyer puts in the CashApp payment note
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','paid','expired')),
  marked_paid_at TEXT,
  paid_at        TEXT,
  payment_note   TEXT,                          -- optional admin note recorded at confirm time
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  -- Buyer contact and shipping info (collected at checkout, no account required)
  buyer_name      TEXT NOT NULL,
  buyer_email     TEXT NOT NULL,
  buyer_phone     TEXT NOT NULL,
  buyer_address1  TEXT NOT NULL,
  buyer_address2  TEXT,
  buyer_city      TEXT NOT NULL,
  buyer_state     TEXT NOT NULL,
  buyer_zip       TEXT NOT NULL,
  buyer_country   TEXT NOT NULL DEFAULT 'US'
);

-- Seller blacklist: PBT seller usernames whose listings should not appear on the site.
CREATE TABLE IF NOT EXISTS seller_blacklist (
  username TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic key/value settings store. Holds CashApp payment config, the PBT
-- scraper's own login (admin-console-configurable rather than a Worker
-- secret), the waybill "From" company info, and the pricing markup — all
-- editable through the admin settings page with no schema change needed.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('cashapp_cashtag', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('cashapp_note', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_name', 'Paws Delivered');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_address', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_city', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_state', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_zip', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('company_phone', '417-451-2252');
INSERT OR IGNORE INTO settings (key, value) VALUES ('markup_usd', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pbt_email', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('pbt_password', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_notification_email', '');
