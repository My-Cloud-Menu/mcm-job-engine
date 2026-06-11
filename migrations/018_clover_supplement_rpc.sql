-- ============================================================
-- 018_clover_supplement_rpc.sql
-- Hardening de concurrencia (Fix 3). El bookkeeping del manifest suplementario
-- (orders.additional_properties.clover_supplemental) era read-modify-write en JS
-- (readManifest → mutar → writeManifest), sin atomicidad: dos `reconcile_items`
-- concurrentes sobre la MISMA orden pagada podían corromper `supplements[]` o
-- doble-billar un ítem solapado (cada uno computaba el delta contra el mismo
-- `billed` y encolaba su propio suplemento).
--
-- Solución: mover el cómputo del delta + el append al manifest a UNA RPC que
-- corre bajo `SELECT ... FOR UPDATE` de la fila `orders`. Así reconcile-2
-- recomputa el delta contra el `billed` YA actualizado por reconcile-1 (incluye
-- su suplemento) → sin solapamiento ni corrupción. TS solo arma los objetos de
-- línea Clover a partir de los `delta_keys` que devuelve la RPC.
--
-- Las "keys" son `name||note` (estables ante el absorber de redondeo).
-- ============================================================

-- Computa el delta atómicamente y appendea la entrada del suplemento (idempotente
-- por delta_signature). Devuelve qué facturar (delta_keys) o el estado vacío/removal.
create or replace function claim_clover_supplement(
  p_site_id                 bigint,
  p_order_id                bigint,
  p_current_keys            jsonb,           -- {lineKey: count} del set congelado actual
  p_seed_billed_keys        jsonb,           -- {lineKey: count} de las líneas actuales del primario en Clover (seed legacy)
  p_primary_clover_order_id text default null
) returns jsonb language plpgsql as $$
declare
  v_ap          jsonb;
  v_manifest    jsonb;
  v_billed      jsonb := '{}'::jsonb;
  v_delta       jsonb := '{}'::jsonb;
  v_has_removal boolean := false;
  v_sig         text;
  v_ext         text;
  v_supp        jsonb;
  rec           record;
begin
  -- Lock de la fila de la orden → serializa el bookkeeping del manifest.
  select additional_properties into v_ap
  from orders where id = p_order_id and site_id = p_site_id
  for update;

  if not found then
    return jsonb_build_object('has_delta', false, 'has_removal', false, 'error', 'order_not_found');
  end if;

  v_ap := coalesce(v_ap, '{}'::jsonb);
  v_manifest := coalesce(v_ap->'clover_supplemental', '{}'::jsonb);

  -- Seed de primary.billed_keys para órdenes legacy (pagadas antes de esta feature).
  if v_manifest->'primary'->'billed_keys' is null then
    v_manifest := jsonb_set(v_manifest, '{primary}', jsonb_build_object(
      'clover_order_id', p_primary_clover_order_id,
      'billed_keys', coalesce(p_seed_billed_keys, '{}'::jsonb)
    ), true);
  end if;

  -- billed = primary.billed_keys + Σ supplements.delta_keys
  v_billed := coalesce(v_manifest->'primary'->'billed_keys', '{}'::jsonb);
  if jsonb_typeof(v_manifest->'supplements') = 'array' then
    for v_supp in select * from jsonb_array_elements(v_manifest->'supplements') loop
      for rec in select key, value from jsonb_each_text(coalesce(v_supp->'delta_keys', '{}'::jsonb)) loop
        v_billed := jsonb_set(v_billed, array[rec.key],
          to_jsonb(coalesce((v_billed->>rec.key)::int, 0) + rec.value::int));
      end loop;
    end loop;
  end if;

  -- delta = current - billed
  for rec in select key, value from jsonb_each_text(coalesce(p_current_keys, '{}'::jsonb)) loop
    if rec.value::int - coalesce((v_billed->>rec.key)::int, 0) > 0 then
      v_delta := jsonb_set(v_delta, array[rec.key], to_jsonb(rec.value::int - coalesce((v_billed->>rec.key)::int, 0)));
    end if;
  end loop;

  -- removal: alguna key facturada que ahora falta o disminuyó
  for rec in select key, value from jsonb_each_text(v_billed) loop
    if coalesce((p_current_keys->>rec.key)::int, 0) < rec.value::int then
      v_has_removal := true;
    end if;
  end loop;

  -- Sin nuevos ítems: persistir el seed (para próximas) y salir.
  if v_delta = '{}'::jsonb then
    update orders
    set additional_properties = jsonb_set(coalesce(additional_properties, '{}'::jsonb), '{clover_supplemental}', v_manifest, true)
    where id = p_order_id and site_id = p_site_id;
    return jsonb_build_object('has_delta', false, 'has_removal', v_has_removal);
  end if;

  -- Signature determinística del delta (keys ordenadas) + externalReferenceId (<=12).
  select string_agg(k || ':' || (v_delta->>k), '|' order by k) into v_sig
  from jsonb_object_keys(v_delta) as k;
  v_sig := substr(md5(v_sig), 1, 12);
  v_ext := 'ms' || substr(md5(p_site_id::text || ':' || p_order_id::text || ':' || v_sig), 1, 10);

  -- Append idempotente por signature (si dos runs computan el MISMO delta, solo 1 entrada).
  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_manifest->'supplements', '[]'::jsonb)) e
    where e->>'delta_signature' = v_sig
  ) then
    v_manifest := jsonb_set(v_manifest, '{supplements}',
      coalesce(v_manifest->'supplements', '[]'::jsonb) || jsonb_build_object(
        'external_reference_id', v_ext,
        'clover_order_id', null,
        'delta_signature', v_sig,
        'delta_keys', v_delta,
        'total_cents', 0
      ), true);
  end if;

  update orders
  set additional_properties = jsonb_set(coalesce(additional_properties, '{}'::jsonb), '{clover_supplemental}', v_manifest, true)
  where id = p_order_id and site_id = p_site_id;

  return jsonb_build_object(
    'has_delta', true,
    'has_removal', v_has_removal,
    'delta_keys', v_delta,
    'delta_signature', v_sig,
    'external_reference_id', v_ext
  );
end;
$$;

-- Persiste atómicamente el clover_order_id (+ total) en la entrada del suplemento.
create or replace function set_clover_supplement_clover_id(
  p_site_id         bigint,
  p_order_id        bigint,
  p_delta_signature text,
  p_clover_order_id text,
  p_total_cents     int default null
) returns void language plpgsql as $$
declare
  v_ap       jsonb;
  v_manifest jsonb;
  v_sups     jsonb := '[]'::jsonb;
  v_e        jsonb;
  v_found    boolean := false;
begin
  select additional_properties into v_ap
  from orders where id = p_order_id and site_id = p_site_id
  for update;
  if not found then return; end if;

  v_manifest := coalesce(v_ap->'clover_supplemental', '{}'::jsonb);
  for v_e in select * from jsonb_array_elements(coalesce(v_manifest->'supplements', '[]'::jsonb)) loop
    if v_e->>'delta_signature' = p_delta_signature then
      v_e := jsonb_set(v_e, '{clover_order_id}', to_jsonb(p_clover_order_id));
      if p_total_cents is not null then
        v_e := jsonb_set(v_e, '{total_cents}', to_jsonb(p_total_cents));
      end if;
      v_found := true;
    end if;
    v_sups := v_sups || v_e;
  end loop;

  if not v_found then
    v_sups := v_sups || jsonb_build_object(
      'external_reference_id', null,
      'clover_order_id', p_clover_order_id,
      'delta_signature', p_delta_signature,
      'delta_keys', '{}'::jsonb,
      'total_cents', coalesce(p_total_cents, 0)
    );
  end if;

  v_manifest := jsonb_set(v_manifest, '{supplements}', v_sups, true);
  update orders
  set additional_properties = jsonb_set(coalesce(additional_properties, '{}'::jsonb), '{clover_supplemental}', v_manifest, true)
  where id = p_order_id and site_id = p_site_id;
end;
$$;
