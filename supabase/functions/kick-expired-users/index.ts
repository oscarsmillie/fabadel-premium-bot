import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.4';

Deno.serve(async (req) => {
  // 1. Initialize Supabase Client (using service_role key from the environment)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        // Set to true for server/service roles to bypass auth checks
        persistSession: false,
      },
    }
  );

  // Get the current time in ISO format for comparison
  const now = new Date().toISOString();

  console.log(`Checking for expired subscriptions before: ${now}`);
  
  // 2. Query the 'subscription' table for expired, active subscriptions
  const { data: expiredSubs, error: selectError } = await supabase
    .from('subscription')
    .select('telegram_id, end_at')
    // Filter 1: end_at is less than the current time (i.e., it's expired)
    .lt('end_at', now) 
    // Filter 2: Only select subscriptions that are currently 'active'
    .eq('status', 'active'); 

  if (selectError) {
    console.error('Error selecting expired subscriptions:', selectError);
    return new Response(
      JSON.stringify({ message: 'Database query failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!expiredSubs || expiredSubs.length === 0) {
    console.log('No active subscriptions found to kick.');
    return new Response(
      JSON.stringify({ message: 'No subscriptions were expired or kicked' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3. Update the found subscriptions to 'expired' and set 'active' to false
  const expiredIds = expiredSubs.map(sub => sub.telegram_id);
  console.log(`Found ${expiredSubs.length} subscriptions to kick: IDs ${expiredIds.join(', ')}`);

  const { error: updateError } = await supabase
    .from('subscription')
    .update({ 
        active: false,
        status: 'expired'
    })
    // Filter by the IDs we found that need to be kicked
    .in('telegram_id', expiredIds)
    .eq('status', 'active'); // Ensure we only update truly active ones

  if (updateError) {
    console.error('Error updating expired subscriptions:', updateError);
    return new Response(
      JSON.stringify({ message: 'Database update failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4. Success Response
  return new Response(
    JSON.stringify({ 
      message: `Successfully deactivated ${expiredSubs.length} subscriptions.`,
      kicked_ids: expiredIds
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});