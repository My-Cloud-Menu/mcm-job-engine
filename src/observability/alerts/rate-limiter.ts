import { supabase } from '../../lib/supabase';
import { config } from '../../config';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface RateLimitVerdict {
  allowed: boolean;
  /** Qué cupo se agotó — va al `failed_reason` de la alerta suprimida. */
  reason?: 'global' | 'per_site';
}

/**
 * Cupos POR CARRIL (034). Antes había uno solo: 20 envíos/hora por destinatario contando TODO,
 * así que una caída ruidosa de un site (702 dead_letters en 24h desde un sandbox muerto) se
 * comía el cupo y silenciaba los `critical` de cualquier otro site.
 *
 * Ahora:
 *   · `critical` tiene su propio carril y NO lo consume el ruido de warning/info. Tampoco le
 *     aplica el techo por site: un critical no se suprime por venir del mismo sitio que otro.
 *   · warning/info comparten el cupo global y además tienen un techo por site, de forma que el
 *     site ruidoso se autolimita y deja cupo libre para los demás.
 *
 * Falla ABIERTO ante error de DB: es preferible un email de más que perder el aviso.
 */
export async function canSend(
  recipient: string,
  severity: AlertSeverity,
  siteId: number | null
): Promise<RateLimitVerdict> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const isCritical = severity === 'critical';

  // ── Carril global ──────────────────────────────────────────
  let globalQuery = supabase
    .from('alert_send_log')
    .select('*', { count: 'exact', head: true })
    .eq('recipient', recipient)
    .gte('sent_at', oneHourAgo);

  globalQuery = isCritical
    ? globalQuery.eq('severity', 'critical')
    : globalQuery.neq('severity', 'critical');

  const { count: globalCount, error: globalError } = await globalQuery;
  if (globalError) return { allowed: true }; // fail open

  const globalLimit = isCritical
    ? config.alerts.rateLimitCriticalPerHour
    : config.alerts.rateLimitPerHour;

  if ((globalCount ?? 0) >= globalLimit) return { allowed: false, reason: 'global' };

  // ── Techo por site (sólo warning/info) ─────────────────────
  if (isCritical || siteId == null) return { allowed: true };

  const { count: siteCount, error: siteError } = await supabase
    .from('alert_send_log')
    .select('*', { count: 'exact', head: true })
    .eq('recipient', recipient)
    .eq('site_id', siteId)
    .neq('severity', 'critical')
    .gte('sent_at', oneHourAgo);

  if (siteError) return { allowed: true }; // fail open

  if ((siteCount ?? 0) >= config.alerts.rateLimitPerSitePerHour) {
    return { allowed: false, reason: 'per_site' };
  }

  return { allowed: true };
}

export async function recordSent(
  recipient: string,
  severity: AlertSeverity,
  siteId: number | null,
  integration: string | null
): Promise<void> {
  await supabase
    .from('alert_send_log')
    .insert({ recipient, severity, site_id: siteId, integration });
}
