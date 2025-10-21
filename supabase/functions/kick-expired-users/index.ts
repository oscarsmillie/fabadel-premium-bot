import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";

// --- Configuration and Initialization ---
// These variables are injected from your .env.local file upon deployment.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const PREMIUM_GROUP = Deno.env.get("PREMIUM_GROUP_ID")!; // e.g., "@FabadelPremiumGroup" or the numeric ID

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Calls the Telegram API to ban a user from the premium group, effectively kicking them.
 * Note: The bot must be an administrator in the group with the 'Ban Users' permission.
 * @param {bigint} userId - The Telegram ID of the user to ban.
 */
async function kickUser(userId: bigint) {
  const url = `${TELEGRAM_API_URL}/banChatMember`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: PREMIUM_GROUP,
      user_id: userId,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    // Log detailed Telegram API error
    console.error(`Telegram API failed to kick user ${userId}: ${data.description}`);
    throw new Error(`Telegram API Error: ${data.description}`);
  }
  return data;
}

/**
 * Main handler for the scheduled job. It only processes GET requests from the scheduler.
 */
async function handler(req: Request) {
  // Ensure the request is a GET, as expected from cron/scheduler services
  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ message: "Method Not Allowed. Only GET requests accepted for this function." }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  // 1. Query Supabase for expired but active users
  const { data: expiredUsers, error: queryError } = await supabase
    .from("subscriptions")
    .select("telegram_id")
    .eq("active", true)
    // Check if the expiration date ('end_at') is before the current time
    .lt("end_at", new Date().toISOString()); 

  if (queryError) {
    console.error("Supabase Query Error:", queryError);
    return new Response(
      JSON.stringify({ error: "Database query failed to find expired users." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!expiredUsers || expiredUsers.length === 0) {
    return new Response(
      JSON.stringify({ message: "No expired users found to process. Job complete." }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`Found ${expiredUsers.length} users with expired subscriptions.`);
  let kickedCount = 0;
  let failedKicks = [];

  // 2. Process Kicks and Database Updates
  for (const user of expiredUsers) {
    // Ensure telegram_id is treated as bigint for Telegram API
    const userId = BigInt(user.telegram_id);
    try {
      // Kick User (Telegram API call)
      await kickUser(userId);

      // 3. Update Status (Supabase RPC call to PostgreSQL function)
      const { error: rpcError } = await supabase.rpc('mark_user_inactive', {
        user_telegram_id: userId
      });

      if (rpcError) {
        console.error(`Failed to update DB status for ${userId}:`, rpcError.message);
        failedKicks.push({ id: userId, reason: `DB update failed: ${rpcError.message}` });
      } else {
        kickedCount++;
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error during kick/update';
      console.error(`Error processing user ${userId}: ${errorMessage}`);
      failedKicks.push({ id: userId, reason: errorMessage });
    }
  }

  return new Response(
    JSON.stringify({ 
      message: "Kick-off job completed.", 
      processed_total: expiredUsers.length,
      kicked_and_updated_successfully: kickedCount,
      failures: failedKicks 
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Start the Deno server and serve the handler
serve(handler);