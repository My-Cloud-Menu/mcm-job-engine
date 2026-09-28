-- 038 · claim_next_job_for_sites — reclamo de jobs limitado a una lista de sites (ADITIVO).
--
-- Por qué: un worker de prueba o de un negocio concreto (p. ej. `WORKER_SITE_IDS=70100000`) no debe procesar
-- los jobs de otros negocios que comparten la misma cola (hoy la cola `billing` tiene atraso de otro site).
-- Cómo: copia EXACTA de la versión viva de `claim_next_job` (volcada el 2026-09-27, md5 bc28068bfeac3ba7ce2d9231a88c6aa3)
-- más un único filtro `j.site_id = any(p_site_ids)`. `claim_next_job` NO se modifica: sin la variable
-- `WORKER_SITE_IDS` el worker sigue llamando a la función de siempre.
-- Reversión: scripts de la misión → `038_claim_site_allowlist.down.sql` (drop function).

create or replace function public.claim_next_job_for_sites(
  p_worker_id text,
  p_queue_name text,
  p_site_ids bigint[],
  p_lock_seconds integer default 180,
  p_integrations text[] default null::text[]
)
returns table(id uuid, site_id bigint, correlation_id uuid, queue_name text, job_type text, integration text,
              payload jsonb, context jsonb, total_steps integer, current_step integer,
              reference_type text, reference_id text)
language plpgsql
set search_path = public
as $function$
declare
  v_job_id uuid;
begin
  if p_site_ids is null or cardinality(p_site_ids) = 0 then
    raise exception 'claim_next_job_for_sites: p_site_ids es obligatorio' using errcode = '22023';
  end if;

  select j.id into v_job_id
  from integration_jobs j
  where j.queue_name = p_queue_name
    and j.site_id = any(p_site_ids)
    and j.status in ('pending', 'retrying')
    and j.scheduled_for <= now()
    and (p_integrations is null or j.integration = any(p_integrations))
    -- Per-integration global limit
    and (
      not exists (
        select 1 from integration_concurrency_limits l
        where l.enabled
          and l.queue_name is null
          and l.site_id is null
          and l.integration = j.integration
          and (
            select count(*) from integration_jobs r
            where r.integration = j.integration
              and r.status = 'running'
          ) >= l.max_concurrency
      )
    )
    -- Per-site limit
    and (
      not exists (
        select 1 from integration_concurrency_limits l
        where l.enabled
          and l.site_id = j.site_id
          and (
            select count(*) from integration_jobs r
            where r.site_id = j.site_id
              and r.status = 'running'
          ) >= l.max_concurrency
      )
    )
  order by j.priority desc, j.scheduled_for asc
  limit 1
  for update skip locked;

  if v_job_id is null then
    return;
  end if;

  update integration_jobs as j
  set status       = 'running',
      locked_by    = p_worker_id,
      locked_until = now() + (p_lock_seconds || ' seconds')::interval,
      updated_at   = now()
  where j.id = v_job_id
  returning
    j.id, j.site_id, j.correlation_id, j.queue_name, j.job_type, j.integration,
    j.payload, j.context, j.total_steps, j.current_step, j.reference_type, j.reference_id
  into
    id, site_id, correlation_id, queue_name, job_type, integration,
    payload, context, total_steps, current_step, reference_type, reference_id;

  return next;
end;
$function$;

-- Solo el worker (service_role) la usa. Postgres concede EXECUTE a PUBLIC por defecto: se revoca explícito.
revoke all on function public.claim_next_job_for_sites(text, text, bigint[], integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_next_job_for_sites(text, text, bigint[], integer, text[]) to service_role;

comment on function public.claim_next_job_for_sites(text, text, bigint[], integer, text[]) is
  'Igual que claim_next_job pero solo toma jobs de los sites indicados (WORKER_SITE_IDS). Aditivo; claim_next_job no cambia.';
