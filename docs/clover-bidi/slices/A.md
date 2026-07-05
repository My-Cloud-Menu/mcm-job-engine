# Slice A — Fundaciones (región/host, merchant, tender)

**Estado:** COMPLETO · **Riesgo:** bajo · aditivo puro.

## Implementado
- **NEW** `src/handlers/clover/region.ts` — `resolveCloverBaseUrl(config)` + `CLOVER_REGION_HOSTS` + `DEFAULT_CLOVER_BASE_URL`. Resuelve el REST base URL por tenant: `config.apiUrl` gana verbatim (comportamiento idéntico al previo para todo config existente) → `config.region` mapea a host canónico (US/EU/LA/sandbox) → default `https://api.clover.com`.
- **EDIT (aditivo)** `src/handlers/clover/client.ts`:
  - `createCloverClient` delega el baseURL a `resolveCloverBaseUrl(config)`. **Provablemente idéntico** para todo config de producción (todos setean `apiUrl`); solo cambia para configs nuevos que usen `region` sin `apiUrl`. Firma sin cambios.
  - `CloverConfigSchema`: añadidos `region` y flags de catálogo (`sync_employees/tables/products/modifiers/item_stock`, `cloverCatalogSyncIntervalSeconds`) como `.optional()`. El schema es `z.object()` (no `.strict()`) → un config de producción existente sigue parseando sin error (G3).
- **NEW** `tests/unit/clover-region.test.ts` — 7 tests: apiUrl gana; region mapea (eu/latam/la/sandbox/US case-insensitive); default sin cambios; region desconocida → default; `CloverConfigSchema.parse()` de config prod-shaped (con key desconocida `defaultTenderId`) OK; nuevos flags opcionales aceptados.

## Verificado (sandbox, Fase 0)
- `GET /v3/merchants/{mId}` → 200 en ambos hosts (`sandbox.dev.clover.com` usado). Merchant "MCM Restaurant Test".
- `GET /tenders` → 200, 15 tenders. **Tender externo "MCM" `4QPPVE0NFNBN4` (enabled)** ya existe y es `config.defaultTenderId` → AC "asegurar tender MCM" satisfecho sin crear nada.

## OAuth (deferred, documentado en BLOQUEOS)
Sandbox usa token estático (merchant API token). El intercambio OAuth expiring (access/refresh) no es testeable sin app OAuth registrada. Se documenta; no hay dead-code activo.

## AC
- [x] Región resuelta desde code o `apiUrl` (7/7 tests).
- [x] `GET /merchants/{mId}` = 200 (smoke).
- [x] Tender "MCM" presente e idempotente (verificado, no duplicado).
- [x] `CloverConfigSchema.parse()` de config prod-shaped OK con campos nuevos ausentes.
- [x] OAuth marcado deferred sin dead-code activo.
- [x] `npx tsc --noEmit` limpio; test verde.
