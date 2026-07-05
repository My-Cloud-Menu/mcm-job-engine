# Compatibilidad con /pos-order (menú + render de órdenes)

**Estado:** VERIFICADO end-to-end. La integración Clover ahora funciona con el POS `mcm-dashboard-2.1/app/pos-order`. Evidencia: `evidence/J-pos-render.json`, `evidence/K-order-modifiers.json`.

## Front 1 — Catálogo visible en el menú del POS
**Hallazgo:** el POS gatea el menú sobre una fila publicada en `catalogs` (channels incluye 'pos'); `get-menus` solo devuelve productos cuya categoría está en `items[].categories_id` del catálogo. El sync escribía products/categories pero **no** tocaba `catalogs` → productos invisibles. (No es específico de Clover: Omnivore tiene la misma dependencia — requiere curar un catálogo POS.)

**Fix (aditivo, flag-gated `autoManageCloverCatalog`, default OFF):** `syncCloverPosCatalog` mantiene UNA fila `catalogs` "Clover (auto)" (identificada por `additional_properties.cloverManaged=true`), channels configurables (default `['pos']`), con un item que lista todas las categorías Clover sincronizadas. Idempotente, scoped por site_id, nunca toca catálogos curados a mano.

**Verificado:** con el flag ON en site 99990001 → catálogo creado (20 categorías linkeadas) → **`get-menus` (lo que consume el POS) devuelve HTTP 200 con 104 productos** con shape completo (price, in_stock, availability_status, categories_id, is_taxable, ingredients). Los 10 restantes son productos **sin categoría en Clover** (por diseño no aparecen en un menú por-categoría). Los modifier groups adjuntan por `products_included` (verificado).

## Front 2 — Render de órdenes traídas
Verificado que una orden Clover traída (`convertCloverOrderToMCMOrder`) puebla todos los campos que el POS renderiza: `channel='pos'`, status, payment_status, totales numéricos, line_items[], `clover_pos_id`, tax_lines, experience, fechas (`J-pos-render.json`: todos los checks true).

**Dos gaps corregidos (aditivo, order-mapper):**
- **Modificadores no se renderizaban** (mapper hardcodeaba `attributes:[]`, ignoraba `lineItems.modifications`). Fix: `attributes[]` + `additional_properties.modifiers[]` desde `modifications`. **Verificado (K):** un modificador "Crossiant" aparece en `attributes` → renderiza en ItemRow del POS (`modifier_rendered:true`).
- **`product_id` era el id de Clover** (no resolvía el producto MCM → acciones edit/repeat/86 fallaban). Fix: mapa `cloverItemId→MCM product id` (construido en `upsert-orders`) pasado al mapper. **Verificado (K):** `product_id_resolved_to_mcm:true` (10117 = producto MCM).

**Caveat de despliegue:** al desplegar este cambio del order-mapper, el próximo pull re-mapea las órdenes abiertas existentes una vez (attributes/product_id se llenan) → un update único por orden abierta (bounded, esperado). Sin churn continuo después.

## Cosméticos / by-design (no rompen render, documentados)
- `quantity` hardcode 1 (modelo Clover: qty = líneas repetidas; el total viene de `cloverOrder.total`).
- `employee` vacío / `experience='pu'` (órdenes Clover no-dine-in; no gatea visibilidad).
- `table_id` scalar null (Clover no expone mesa en el order object → orden tratada como cola compartida no-dine-in, correcto para pickup).
- órdenes `check-closed` (pagadas) no aparecen en el floor del POS (por diseño — `POS_VISIBLE_ORDER_STATUSES`).

## AC
- [x] Catálogo sincronizado visible en el menú del POS vía `get-menus` (104/114; 10 sin categoría por diseño).
- [x] Orden traída renderiza todos los campos críticos.
- [x] Modificadores renderizan en líneas traídas.
- [x] `product_id` resuelve al producto MCM (acciones interactivas/86).
- [x] POS/O&P sin cambios de código (todo el fix es backend + una fila `catalogs`).
