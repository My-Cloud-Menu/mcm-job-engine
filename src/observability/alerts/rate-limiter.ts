import { supabase } from '../../lib/supabase';
import { config } from '../../config';

/** Returns true if the recipient is under the hourly send rate limit. Fails open on DB error. */
export async function canSend(recipient: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('alert_send_log')
    .select('*', { count: 'exact', head: true })
    .eq('recipient', recipient)
    .gte('sent_at', oneHourAgo);

  if (error) return true; // fail open

  return (count ?? 0) < config.alerts.rateLimitPerHour;
}

export async function recordSent(recipient: string): Promise<void> {
  await supabase.from('alert_send_log').insert({ recipient });
}
