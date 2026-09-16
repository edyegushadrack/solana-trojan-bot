import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

let client = null;
let attempted = false;

/**
 * Returns a Supabase client for the meme-scanner project, or null if
 * SUPABASE_URL/SUPABASE_ANON_KEY aren't set — deployer-history checks are
 * optional, not required, so the bot runs fine without them configured.
 */
export function getSupabaseClient() {
  if (attempted) return client;
  attempted = true;

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }

  client = createClient(config.supabaseUrl, config.supabaseAnonKey);
  return client;
}
