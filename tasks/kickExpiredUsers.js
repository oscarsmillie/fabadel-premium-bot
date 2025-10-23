// /tasks/kickExpiredUsers.js
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

export async function kickExpiredUsers(bot) {
  console.log("🚨 Running cron job: Checking expired subscriptions...");

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data: expiredUsers, error } = await supabase
      .from("subscriptions")
      .select("telegram_id, end_at, plan, status, payment_ref")
      .eq("status", "active")
      .lt("end_at", new Date().toISOString());

    if (error) throw error;

    if (!expiredUsers || expiredUsers.length === 0) {
      console.log("✅ No expired users found at this time.");
      return;
    }

    console.log(`⚠️ Found ${expiredUsers.length} expired user(s).`);

    const kickedIds = [];

    for (const user of expiredUsers) {
      try {
        // Notify user
        await bot.telegram.sendMessage(
          user.telegram_id,
          `🚫 Hello! Your Fabadel Premium subscription has expired.\n\nRenew now to regain access to exclusive job opportunities and premium resources.\n\n👉 /plans`
        );

        // Kick from premium group
        await bot.telegram.banChatMember(process.env.PREMIUM_GROUP, user.telegram_id, {
          until_date: Math.floor(Date.now() / 1000) + 300,
        });
        await bot.telegram.unbanChatMember(process.env.PREMIUM_GROUP, user.telegram_id);

        kickedIds.push(user.telegram_id);
      } catch (err) {
        console.error(`❌ Failed to remove user ${user.telegram_id}:`, err.message);
      }
    }

    if (kickedIds.length > 0) {
      await supabase
        .from("subscriptions")
        .update({ status: "expired", active: false })
        .in("telegram_id", kickedIds);

      console.log(`✅ Marked ${kickedIds.length} users as expired.`);

      await bot.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID,
        `📢 ${kickedIds.length} subscription(s) expired and users were notified & removed.`,
        { parse_mode: "Markdown" }
      );
    }

    console.log("✅ Expired user cleanup complete.");
  } catch (err) {
    console.error("❌ Error running kickExpiredUsers:", err);
  }
      }
