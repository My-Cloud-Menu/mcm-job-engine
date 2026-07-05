# Fase 0 — Smoke test + host gate + provisión (reporte)

**Fecha:** 2026-07-02 · **Entorno:** DEV Supabase `blbelbdvykpvbeqbjqom` + Clover sandbox.
**Script:** `docs/clover-bidi/scripts/00-smoke.cjs` · **Evidencia:** `evidence/00-smoke.json` (redacted).

## Credenciales (sin exponer secretos)
- Fuente: `site_integrations` de DEV, site **25512412** (provider=clover, type=pos, active=true).
- `merchantId` = `7ES0TRRRYJCY1`; `apiUrl` configurado = `https://sandbox.dev.clover.com`; `apiKey` presente (len 36).
- El `apiKey` se escribió **solo** al scratchpad de sesión (`clover-sandbox.env`, fuera de todo repo, modo 600). Nunca impreso.

## Host gate (⚠️ discrepancia resuelta)
`GET /v3/merchants/{mId}` con Bearer token:

| Host | Status |
|---|---|
| `https://sandbox.dev.clover.com` (configurado) | **200 ✅** |
| `https://apisandbox.dev.clover.com` (doc oficial) | **200 ✅** |

Ambos hosts REST autentican. **No hay bug**; se usa el configurado `sandbox.dev.clover.com` (consistencia con el código de producción existente).

## Smoke
- **Merchant:** "MCM Restaurant Test" (`7ES0TRRRYJCY1`) — merchant de prueba.
- **Tenders:** 15 (status 200). Incluye tender externo **"MCM" `4QPPVE0NFNBN4` (enabled)** = `config.defaultTenderId`, y "External Payment" (`83BVTM1R6W0GT`, `com.clover.tender.external_payment`). → El AC de Slice A "tender externo MCM" ya está satisfecho.
- **Items:** accesibles (status 200).

## Provisión DEV (idempotente)
- `sites`: **A `99990001`** (`clover-sandbox-test-a`) + **B `99990002`** (`clover-sandbox-test-b`), org 6 ("My Cloud Menu"), status active, PR. `ON CONFLICT (id) DO NOTHING`.
- `site_integrations`: A = clon del row Clover de 25512412 (mismo merchant, host, token), `active=true`. **B sin Clover** (control de aislamiento).

## Gates (auto-check)
- [x] Auth OK contra sandbox (200 en merchant/tenders/items).
- [x] `site_id` en todas las queries (25512412, 99990001, 99990002 explícitos).
- [x] Sin tocar código de producción (solo lecturas + inserts de sites de prueba nuevos).
- [x] Secreto no expuesto (token solo en scratchpad; evidencia redacted).
- [x] Nada `⚠️ NO VERIFICADO` en Fase 0.

**Siguiente:** Fase 1/2/3 (docs) + Slice A.
