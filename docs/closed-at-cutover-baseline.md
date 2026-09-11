# Línea base del cambio a `closed_at` — 2026-09-11, ANTES de desplegar

Foto tomada justo antes del cutover del carril `omnivore.fetch_closed_orders`
(`opened_at` 24 h → `closed_at` 2 h). Sin esta foto no se puede afirmar después que nada se rompió.

Proyecto: `blbelbdvykpvbeqbjqom`. Tomada a las **2026-09-11 ~22:20 UTC**.

| Site | | Cierres/día (7 d) | Corridas/24 h | s por corrida | Dead letters 24 h | Colgadas >26 h (30 d) |
|---|---|---|---|---|---|---|
| 70080000 | CC Music Hall | 418,9 | **123** | **134,8** | **20** | 16 |
| 51021421 | Arena Medalla | 370,9 | 728 | **342,0** | 9 | **1.278** |
| 1173690 | Numen | 12,0 | 935 | 14,0 | 0 | 90 |
| 48372619 | Pala Pizza | 0,0 | 946 | 4,4 | 0 | 1 |

Lo esperado tras el cambio: **`s por corrida` baja** y **`corridas/24 h` sube** hacia las ~960 que
marca el schedule de 90 s. Lo que **no puede** moverse: `cierres/día` (no puede bajar) ni
`colgadas >26 h` (no puede subir).

> Ojo con las 1.278 colgadas de 51021421: son la **línea base**, no un efecto de este cambio. No se
> investigaron. Pueden ser tabs abandonados, o el hueco de los tickets de más de 24 h que este mismo
> cambio cierra — en cuyo caso el número debería **bajar**, no subir.

## Cómo repetir la medición

```sql
with sites as (select unnest(array[51021421,70080000,1173690,48372619]) sid),
cierres as (
  select o.site_id, count(*)::numeric/7 as cierres_dia
  from orders o where o.site_id in (select sid from sites)
    and o.status='check-closed' and o.date_created > now() - interval '7 days'
  group by 1),
jobs as (
  select j.site_id, count(*) as corridas_24h,
         round(avg(extract(epoch from (j.completed_at-j.created_at)))::numeric,1) as seg_prom,
         count(*) filter (where j.status='dead_letter') as muertas_24h
  from integration_jobs j
  where j.integration='omnivore' and j.job_type='fetch_closed_orders'
    and j.created_at > now() - interval '24 hours'
  group by 1),
colgadas as (
  select o.site_id, count(*) as abiertas_mas_26h
  from orders o where o.site_id in (select sid from sites)
    and o.closed_at is null and o.status in ('new-order','in-kitchen','ready-for-pickup')
    and o.date_created < now() - interval '26 hours'
    and o.date_created > now() - interval '30 days'
  group by 1)
select s.sid as site_id,
       round(coalesce(c.cierres_dia,0),1) as cierres_por_dia_7d,
       coalesce(j.corridas_24h,0) as corridas_24h,
       coalesce(j.seg_prom,0) as seg_por_corrida,
       coalesce(j.muertas_24h,0) as muertas_24h,
       coalesce(g.abiertas_mas_26h,0) as colgadas_mas_26h
from sites s
left join cierres c on c.site_id=s.sid
left join jobs j on j.site_id=s.sid
left join colgadas g on g.site_id=s.sid
order by 2 desc;
```

Y el control de cierres perdidos (lo que de verdad hay que vigilar) — órdenes que en MCM siguen
abiertas pero cuyo ticket ya está cerrado en el POS:

```sql
select site_id, count(*)
from orders
where site_id in (51021421,70080000,1173690,48372619)
  and closed_at is null
  and status in ('new-order','in-kitchen','ready-for-pickup')
  and date_created between now() - interval '7 days' and now() - interval '3 hours'
group by 1;
```

## Rollback

No hay bandera por site: revertir el commit y redesplegar el worker `pos_sync`. El modo `'today'`
(ventana de 24 h sobre `opened_at`) sigue vivo e intacto en `order-mapper.ts`, así que la vuelta
atrás es un cambio de una palabra en `fetch-closed-orders.ts:57`.
