-- Migration: Add dialpad_user_id to clients (for user-level call forwarding toggle)
-- Run in: https://supabase.com/dashboard/project/pvphgusjofufwtyiyviu/editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS dialpad_user_id TEXT;

-- CP Cabinets: Glauber/Sara Dialpad user ID
UPDATE clients
SET dialpad_user_id = '6084954296598528'
WHERE id = '5221cab9-a741-4ddc-a752-2359826fba95';
