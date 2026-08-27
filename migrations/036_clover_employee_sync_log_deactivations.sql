-- El sync de empleados de Clover ya calculaba cuántos daba de baja, y lo TIRABA:
-- `clover_employee_sync_log` sólo tiene total/created/updated/skipped_no_pin. El único rastro de
-- una desactivación masiva era un `logger.info` en el worker, que rota en Easy Panel. Si el suelo
-- anti-wipe salta de madrugada, o si un despido no se aplica, hoy no queda NADA consultable en la
-- base para reconstruir qué pasó.
--
-- Tres columnas aditivas, todas con default, así que nada existente se rompe:
--   · employees_deactivated       — bajas aplicadas en esa corrida
--   · employees_reactivated       — recontratados a los que se les devolvió el PIN
--   · deactivation_skipped_reason — por qué NO se aplicaron (el suelo anti-wipe), en texto
--
-- `deactivation_skipped_reason` es text y no boolean a propósito: "se saltó" no dice nada;
-- "18 bajas sobre 20 gestionados" permite decidir sin abrir el worker.

alter table public.clover_employee_sync_log
  add column if not exists employees_deactivated       integer default 0,
  add column if not exists employees_reactivated       integer default 0,
  add column if not exists deactivation_skipped_reason text;

comment on column public.clover_employee_sync_log.employees_deactivated is
  'Empleados desactivados en esta corrida por estar ausentes del roster de Clover.';
comment on column public.clover_employee_sync_log.employees_reactivated is
  'Empleados reactivados por volver al roster (sólo los que llevaban `clover_roster_absent`).';
comment on column public.clover_employee_sync_log.deactivation_skipped_reason is
  'Si el suelo anti-wipe bloqueó las bajas, el porqué con sus cifras. NULL = no se bloqueó nada.';
