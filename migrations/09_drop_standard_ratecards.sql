-- Migration: 09_drop_standard_ratecards.sql
-- Description: Completely retire standard per-minute call rate cards in retail.
--              Retail only utilizes subscription packages and Recording Rate Cards (rec_rate_card).

-- 1. Drop trigger if it exists on rate_cards
DROP TRIGGER IF EXISTS update_rate_cards_updated_at ON rate_cards;

-- 2. Drop junction mapping table customer_ratecard (references rate_cards)
DROP TABLE IF EXISTS customer_ratecard CASCADE;

-- 3. Drop standard rate cards table
DROP TABLE IF EXISTS rate_cards CASCADE;

-- 4. Note: rec_rate_card and customer_rec_rc are preserved and remain active for recording charges.

