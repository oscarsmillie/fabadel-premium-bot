// /supabase/functions/kick-expired-users/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

// --- GLOBAL UTILITY: BigInt Serialization Fix ---
// This function handles the BigInt error by converting BigInts to strings.
const customJSONStringify = (data: any) => {
  return JSON.stringify(data, (key, value) => {
    // Check if the value is a BigInt
    if (typeof value === "bigint") {
      // Convert the BigInt to a string for safe serialization
      return value.toString();
    }
    // Return all other types as is
    return value;
  });
};

// --- TELEGRAM NOTIFICATION FUNCTION ---
async function sendTelegramNotification(message: string): Promise<void> {
  const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set in secrets.");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const params = {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: "Markdown", // Using Markdown for better formatting
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Use the custom serializer just in case `params` somehow contains a BigInt (less likely here)
      body: customJSONStringify(params), 
    });
    if (!response.ok) {
        console.error("Telegram API response was not OK:", await response.text());
    }
  } catch (error) {
    console.error("Failed to send Telegram notification:", error);
  }
}

// --- CORE HANDLER ---

serve(async (req) => {
  const { url, method } = req;
  console.log(`Received request: ${method} ${url}`);

  try {
    const supabaseClient = createClient(
      // Standard Supabase URL and Key setup for Edge Functions
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      // Use the Service Role Key for write operations (kicking users)
      { global: { headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` } } }
    );

    const now = new Date().toISOString();

    // 1. Find users whose subscription has expired
    const { data: expiredUsers, error: fetchError } = await supabaseClient
      .from("users")
      .select("id, email, subscription_expires_at")
      .lt("subscription_expires_at", now)
      .eq("is_active", true); // Assuming an 'is_active' flag

    if (fetchError) throw new Error(`Supabase fetch error: ${fetchError.message}`);

    const expiredUserIds = expiredUsers.map((user: any) => user.id);
    
    console.log(`Found ${expiredUserIds.length} users with expired subscriptions.`);

    if (expiredUserIds.length > 0) {
      // 2. Kick Users (Update their status)
      const { error: updateError } = await supabaseClient
        .from("users")
        .update({ is_active: false })
        .in("id", expiredUserIds);

      if (updateError) throw new Error(`Supabase update error: ${updateError.message}`);

      // 🚨 ADD THIS BLOCK: Update the SUBSCRIPTIONS table status
      const { error: subsUpdateError } = await supabaseClient
        .from("subscriptions") // <-- TARGET YOUR SUBSCRIPTION TABLE NAME
        .update({ status: 'expired', is_active: false }) // <-- SET CORRECT STATUS COLUMN
        .in("user_id", expiredUserIds); // <-- MATCH BY THE COLUMN THAT LINKS TO USER ID

      if (subsUpdateError) throw new Error(`Subscriptions update error: ${subsUpdateError.message}`);

      // 3. Send Telegram Notification for Expirations
      const expiredList = expiredUsers.map((u: any) => `- ${u.email || 'ID: ' + u.id}`).join('\n');
      const expirationMessage = 
        `🛑 *Subscription Expiration Notice!* 🛑\n\n` +
        `**${expiredUserIds.length}** users have been marked *inactive*:\n` +
        `${expiredList}`;
        
      await sendTelegramNotification(expirationMessage);
    }
    
    // NOTE: For NEW Subscriptions, you should use a separate Database Trigger
    // that calls an Edge Function specifically for that event.
    // Example call (you'd need a separate trigger/function for this):
    // await sendTelegramNotification("✨ *New Subscriber Alert!* ✨\nUser ID: `123456789`");


    // 4. Return success response
    const responseBody = { 
      message: "Expired users processed successfully.", 
      count: expiredUserIds.length 
    };

    // --- BIGINT FIX APPLIED HERE ---
    // This is the line where your original error was likely happening (index.ts:105)
    return new Response(customJSONStringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    
  } catch (error) {
    console.error("Function failed:", error.message);
    
    const errorBody = { message: "Internal server error", detail: error.message };

    // --- BIGINT FIX APPLIED HERE ---
    // Apply the fix to the error response as well, just in case.
    return new Response(customJSONStringify(errorBody), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});