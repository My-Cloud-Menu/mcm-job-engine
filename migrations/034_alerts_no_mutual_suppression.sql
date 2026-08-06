-- ============================================================
-- 034_alerts_no_mutual_suppression.sql
--
-- Que una caída ruidosa no silencie el aviso de otro incidente.
--
-- Estado previo (visto el 2026-08-06): 702 alertas `dead_letter` en 24h, casi todas de una
-- location de sandbox muerta. El cupo de envío es UNO SOLO — `alert_send_log` sólo guarda
-- (recipient, sent_at) y `canSend()` cuenta todo junto contra ALERT_RATE_LIMIT_PER_HOUR=20 —
-- y `dispatcher.ts::processAlert` marca `suppressed` sin mirar la severidad. O sea: un
-- `critical` se calla exactamente igual que un `info`, y lo calla el ruido de otro site.
--
-- Dos cambios aquí (el tercero, los carriles de cupo, va en el worker):
--
--   1) Cool-down por `dedupe_key`. Hoy `enqueue_alert` sólo agrupa mientras la fila está
--      `pending` y tiene <5 min; como el dispatcher drena cada 5s, casi nunca llega a agrupar
--      → un email por evento. Ahora, si ya se ENVIÓ una alerta con la misma dedupe_key dentro
--      de la ventana de su severidad, se incrementa el contador de esa fila en vez de crear
--      otra pendiente. Una caída de 6h pasa de ~120 emails de un site a ~24.
--      Ventanas: critical 5 min · warning 15 min · info 30 min.
--
--   2) `alert_send_log` gana `severity`, `site_id` e `integration` para que el worker pueda
--      contar por carril en vez de todo contra el mismo cupo.
--
-- Nada se pierde por agrupar: `count` / `first_seen_at` / `last_seen_at` siguen creciendo en la
-- fila y `buildBody` del dispatcher ya los imprime ("×N desde ..."), así que el email que sí sale
-- lleva el total real.
--
-- Firma de enqueue_alert IDÉNTICA → CREATE OR REPLACE limpio, sin tocar los ~10 callers.
-- ============================================================

-- ── 1. alert_send_log: contexto para contar por carril ───────
alter table alert_send_log add column if not exists severity    alert_severity;
alter table alert_send_log add column if not exists site_id     bigint;
alter table alert_send_log add column if not exists integration text;

-- Las filas viejas no tienen severidad; que cuenten como el carril no-crítico (el conservador).
update alert_send_log set severity = 'warning'::alert_severity where severity is null;

-- El rate limiter consulta por (recipient, sent_at) y por (recipient, site_id, sent_at).
create index if not exists idx_alert_send_log_recipient_sent
  on alert_send_log (recipient, sent_at desc);
create index if not exists idx_alert_send_log_recipient_site_sent
  on alert_send_log (recipient, site_id, sent_at desc)
  where site_id is not null;

-- ── 2. enqueue_alert con cool-down por dedupe_key ────────────
create or replace function public.enqueue_alert(
  p_dedupe_key  text,
  p_severity    alert_severity,
  p_event_type  text,
  p_subject     text,
  p_body        text,
  p_metadata    jsonb  default '{}'::jsonb,
  p_site_id     bigint default null,
  p_integration text   default null
) returns uuid language plpgsql as $$
declare
  v_existing_id uuid;
  v_new_id      uuid;
  v_cooldown    interval;
begin
  -- (a) Agrupar en la fila que todavía no se ha enviado. Comportamiento original.
  select id into v_existing_id
  from alerts_outbox
  where dedupe_key = p_dedupe_key
    and status = 'pending'
    and created_at >= now() - interval '5 minutes'
  order by created_at desc
  limit 1;

  if v_existing_id is not null then
    update alerts_outbox
    set count        = count + 1,
        last_seen_at = now(),
        metadata     = metadata || p_metadata,
        updated_at   = now()
    where id = v_existing_id;
    return v_existing_id;
  end if;

  -- (b) 034: cool-down sobre la ÚLTIMA YA ENVIADA con la misma dedupe_key. Sin esto, un fallo
  -- que se repite cada 2 minutos manda un email cada 2 minutos y agota el cupo de todos.
  v_cooldown := case p_severity::text
                  when 'critical' then interval '5 minutes'
                  when 'warning'  then interval '15 minutes'
                  else                 interval '30 minutes'
                end;

  select id into v_existing_id
  from alerts_outbox
  where dedupe_key = p_dedupe_key
    and status = 'sent'
    and sent_at >= now() - v_cooldown
  order by sent_at desc
  limit 1;

  if v_existing_id is not null then
    update alerts_outbox
    set count        = count + 1,
        last_seen_at = now(),
        metadata     = metadata || p_metadata,
        updated_at   = now()
    where id = v_existing_id;
    return v_existing_id;
  end if;

  insert into alerts_outbox (
    dedupe_key, severity, event_type, subject, body,
    metadata, site_id, integration
  ) values (
    p_dedupe_key, p_severity, p_event_type, p_subject, p_body,
    p_metadata, p_site_id, p_integration
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;
