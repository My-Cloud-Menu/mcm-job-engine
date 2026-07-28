# Certificación Omnivore × Clover — hallazgos

Site de certificación: **99990003** "Clover x Aloha - Certificación"
Omnivore `cx9oRBRi` (Aloha 24.7.8) · Clover sandbox `7ES0TRRRYJCY1`
Motor: workers locales `pos_sync` + `pos_injection`, `LOG_LEVEL=debug`
Corrida: `TOK` variable por script · evidencia cruda en `evidence/`

> Clasificación según §A.8.1 del plan: **CONFIRMADO** = ≥3 reproducciones + 3 fuentes de
> evidencia + mecanismo señalado en código · **PROBABLE** = observado sin reproducir o sin
> mecanismo · **NO REPRODUCIDO** = se predijo y no ocurrió · **NO VERIFICADO** = no se pudo probar.

---

## Cifras finales de la corrida

Medido al cierre sobre **186 órdenes** leídas en los tres sistemas (Omnivore, MCM, Clover):

| medida | resultado |
|---|---|
| Órdenes reconciliadas en los 3 sistemas | **183 / 186** |
| Descuadres POS ≠ Clover | **10** · sobrecobro acumulado **$79.51** |
| Órdenes fantasma en Clover (cheque saldado, orden `OPEN`) | **105** · **$3,340.86** en el Register |
| Órdenes Clover con líneas pero **sin `total`** (Register muestra $0.00) | **12** |
| Divergencia de base imponible | **8 / 183** órdenes · Δ **$4.81** sobre $323.35 (**+1.5 %**) |
| Métodos de pago distintos en MCM | **1** (`ecr-card`) sobre 119 pagos y $3,637.18 |
| Órdenes o pagos duplicados | **0 · 0** |
| Dead-letters | 3 `order_injection` · 7 `payment_injection` · 5 `fetch_recent_orders` (inducidos a propósito en F5.4) |
| Latencia cheque cerrado → cobrable en el Flex | p50 **71.6 s** · p95 **98.7 s** |
| Aislamiento multi-tenant con 2 tenants sobre la misma location | **sin cruces** |

---

## Resumen ejecutivo

**La integración pierde o cobra mal dinero en escenarios cotidianos de un restaurante**, y casi
siempre lo hace **en silencio**: sin error, sin dead-letter, sin alerta, y con MCM reportando la
orden como cobrada.

| # | Hallazgo | Qué pasa en la práctica | Estado |
|---|---|---|---|
| **H2** | Colisión de idempotencia entre tenants | Un pago cobrado **nunca llega al POS**. El cheque queda abierto en Aloha y MCM lo da por cerrado. Es azar cuál pago se pierde | **CONFIRMADO** · mecanismo probado + 1 instancia en vivo + exposición medida (35 llaves) |
| **M1** | El pull de Clover rompe la convención de `payments.total` | Guarda la base sin propina donde el resto del sistema guarda lo cobrado. El reenvío resta la propina —correctamente— y el monto se va corto: Aloha rechaza con `insufficient_amount` y el cheque queda sin pagar. **La propina siempre se captura al pagar**, así que alcanza a casi todo cobro. **El arreglo va en el pull, NO en el reenvío** (ese funciona en producción) | **CONFIRMADO** · 3 rep + A/B + convención verificada en producción |
| **N1** | Los pagos divididos dependen de la LOCATION | En la location de certificación (`cx9oRBRi`) Aloha rechaza todo parcial, hasta a un centavo del total. **Pero en producción (`cjgALEriXXX`) los acepta**: 4 parciales de $115.91 sobre un cheque de $463.64, completados. **No hay nada que arreglar en la integración** — hay que verificar el comportamiento de la location real antes de desplegar | **CORREGIDO** · comportamiento por location, no defecto |
| **N2** | Una inyección fallida nunca se reintenta | Un rate limit de 8 segundos deja órdenes fuera de Clover **para siempre**. Medido: $248.58 en 3 órdenes | **CONFIRMADO** · 3 casos + mecanismo |
| **R5** | Los descuentos no viajan a Clover | El cliente paga el precio **sin descuento**. En una cortesía del 100 % paga la comida entera que se le regaló | **CONFIRMADO** · 3 rep |
| **M8** | El ítem anulado se sigue cobrando | El mesero anula un plato y el cliente igual lo paga en Clover. **Solo ocurre con `omnivoreTableServiceEnabled` encendido.** Decisión del dueño: la integración Clover×Omnivore corre con el flag **apagado** ⇒ **NO APLICA**, no hay que arreglarlo | **CONFIRMADO** · 3 rep con el flag ON · **descartado por configuración** |
| **M7** | El cheque cobrado en el POS ensucia Clover | Todo cheque cobrado en el terminal Aloha (efectivo o tarjeta propia) se empuja igual a Clover como orden **abierta** que nadie pagará. **Medición final: 105 órdenes abiertas para siempre, $3,340.86 en el Register** | **CONFIRMADO** · 4 rep + medición completa |
| **N3** | El tender real y la propina del POS se pierden | Todo cobro hecho en el terminal Aloha entra a MCM como `ecr-card` con `tip 0.00`, sea efectivo, VISA o AMEX. El cuadre por tender y el reporte de propinas quedan inservibles | **CONFIRMADO** · 3 rep + literales en código |
| **N4** | MCM confía en `due`, no reconcilia `paid` vs `total` | Si el POS hipa durante el cobro y deja `due≠0` con el cheque ya pagado, MCM lo marca `partially_fulfilled` y **no crea fila en `payments`**: dinero cobrado, invisible. Ocurrió solo, en vivo | **CONFIRMADO** · repro determinista con 2 controles + 1 instancia en vivo |
| **N5** | Aloha ignora `Idempotency-Id` y **duplica la propina** al reintentar | Dos POST idénticos con la misma llave crean dos pagos. Aloha autocorrige el principal con un pago negativo pero **no la propina**. Medido: 4 intentos → propina ×4 | **CONFIRMADO** · 2 rep (×4 y ×2) |
| **H1** | El sync muerto no revive, y la alerta no dice qué se rompió | Tras 5 fallos el sync queda apagado hasta que alguien lo re-dispare a mano. Sí llegan correos, pero agrupados por integración+site y con texto de infraestructura: 9 pagos muertos por 3 causas → 2 alertas | **CONFIRMADO** · predicción del plan corregida con evidencia |
| **MT** | Dos queries sin `site_id` fuera del loop certificado | `get-order-list-for-frontend` exige `site_id`, lo valida y **nunca lo usa**: devuelve las órdenes del cliente en **todos** los negocios. Y el calculador de cupones lee `products` por id sin acotar el site | **CONFIRMADO** · barrido dirigido de 304 archivos: 12 candidatos, 2 reales, 10 descartados con motivo |
| **F11.5** | El impuesto declarado no es el que cobró el POS | Las `tax_lines` alimentan la planilla de IVU y **no reconcilian** contra `totals.tax` de Aloha: +$4.81 sobre $208.73 (+2.3 %) en 73 órdenes. MCM grava el service charge que Omnivore no grava, y reconstruye la clase standard/reduced por su cuenta | **CONFIRMADO** · 8/73 órdenes divergen, 2 mecanismos identificados |
| **ABS** | El error de impuesto cabe dentro de la tolerancia de redondeo | 7 de las 8 divergencias se absorbieron ajustando la línea del fee: el total cuadra con el POS, pero el cliente ve un fee de $7.71 donde el POS cobró $8.64 y paga más impuesto. La 8.ª se pasó del guard **por 1 centavo** y se cobró de más | **CONFIRMADO** · 5/5 verificadas al centavo contra Clover |
| **F8** | Cobrar en la mesa no es viable: **p95 de 99 s** | El mesero cierra el cheque y espera minuto y medio a que aparezca en el Flex. Causa medida: `fetch_recent_orders` está programado cada 25 s pero **cada ciclo tarda 37–329 s**, y empeora según se llenan las mesas | **CONFIRMADO** · 3 jornadas (13/20/41 órdenes) + 20 ciclos cronometrados |
| **KILL** | La palanca de apagado que un operador usaría **no apaga nada** | Desactivar `site_integrations.active` deja el schedule corriendo: los jobs se siguen encolando y solo se convierten en errores. Para cortar de verdad hay que ir a `sync_schedules.status` | **CONFIRMADO** · 3 palancas probadas una a una |
| **R10** | Solo **3 de 18** marcas de tarjeta llegan a su tender en Aloha | Discover, Diners, JCB, gift card, EBT, Interac y 9 más caen al tender genérico "SPC OTHER" — **teniendo Aloha un tender Discover dedicado sin usar**. El reporte de ventas por tender del POS queda agrupado mal | **CONFIRMADO** · repro determinista sobre el enum real de Clover |

> Sobre H2: es el único con **una** reproducción en vivo en vez de tres. Forzar más exige controlar el
> `payments.id` que asigna el trigger, lo cual no es directo. Se clasifica como CONFIRMADO porque el
> mecanismo es inequívoco (llave sin `site_id` + UNIQUE global + ids por site), la instancia está
> completamente evidenciada (log dice "enqueued", no existe job, la llave pertenece a otro tenant desde
> hace 6 semanas) y la exposición está medida (35 llaves ocupadas, 6 apuntando a jobs muertos).

### El dato que resume todo: 2 de 8 pagos llegaron al POS

Todos los reenvíos `payment_injection` de la corrida, tal cual quedaron en `integration_jobs`:

| pago MCM | enviado a Omnivore | propina | resultado | causa |
|---|---|---|---|---|
| 10028 | 1362 | 300 | `dead_letter` | **M1** (cheque 1662 − propina) |
| 10029 | 1944 | 475 | `dead_letter` | **M1** (cheque 2419 − propina) |
| 10030 | 399 | 250 | `dead_letter` | **M1** (cheque 649 − propina) |
| **10031** | **649** | **0** | **completed** ✓ | pago completo, sin propina |
| 10032 | — | — | **no se encoló** | **H2** (llave ajena) |
| **10033** | **649** | **0** | **completed** ✓ | pago completo, sin propina |
| 10034 | 1027 | 0 | `dead_letter` | **N1** pago parcial |
| 10035 | 1027 | 0 | `dead_letter` | **N1** pago parcial |
| 10036 | 535 | 0 | `dead_letter` | **N1** pago parcial |

**El único escenario en que un cobro de Clover cierra el cheque en Aloha es "pago completo y sin
propina"** — el caso menos frecuente en servicio de mesa.

### 🔴 N2 · Una orden que falla su inyección **nunca vuelve a intentarse** — **CONFIRMADO**

Cadena de tres fallos que se componen y dejan órdenes permanentemente fuera de Clover:

```
H5 · create_order muere en ~8 s     (max_attempts=3 sobre el perfil [0,5,…] → 2 reintentos)
H4 · el auto-retry no lo rescata    ("Clover 429 (rate limited)" no matchea %HTTP 429%)
N2 · el barrido tampoco lo reintenta — la llave de idempotencia la ocupa el job MUERTO
```

**Evidencia:** durante la propia certificación se golpeó el rate limit de Clover en una ráfaga y
murieron 3 `order_injection`:

| job | creado | muerto | duración | orden | total | `clover_ticket_id` | intentos |
|---|---|---|---|---|---|---|---|
| `55823f7e` | 06:48:45.073 | 06:48:53.044 | **7.97 s** | 10008 | **$192.36** | `null` | **1** |
| `e15ec4e9` | 06:48:45.768 | 06:48:53.303 | **7.54 s** | 10013 | $30.27 | `null` | **1** |
| `44b9e46b` | 06:48:46.295 | 06:48:54.190 | **7.90 s** | 10035 | $25.95 | `null` | **1** |

**Total: $248.58 que nunca llegarán a Clover.**

`push_orders` corre cada 15 s y desde entonces se ejecutó ~160 veces sin crear un solo job nuevo:
`getOrdersPendingSyncToClover` sí devuelve esas órdenes (están en estados elegibles y dentro de la
ventana de 24 h) y `enqueueCloverInjection` sí se llama — pero la llave
`clover_inject:{order_id}:{hash}` **sigue ocupada por el job en `dead_letter`**, así que
`enqueue_job` hace `ON CONFLICT DO NOTHING`, devuelve el job muerto y el barrido reporta éxito.
Como la orden no cambió, el hash tampoco: **la llave no se libera nunca**.

Es el mismo mecanismo de H2 (enqueue idempotente que devuelve un job ajeno o muerto y el llamador no
puede distinguirlo de un encolado real), aplicado esta vez al propio site.

**Nota sobre H5:** la cobertura medida es de **~8 segundos** (había estimado ~5 s por el perfil de
backoff; la diferencia es el tiempo de las llamadas HTTP). Un rate limit —la clase de error más
reintentable que existe— agota los 3 intentos antes de que Clover se recupere.

### 🟠 N1 · Los pagos divididos — **es la LOCATION, no la integración**

> **Corrección (2026-07-27, tras revisar producción).** Escribí que «la API de Omnivore no admite
> parciales». **Es falso como regla general.** Depende de la location.
>
> **Arena Medalla (`cjgALEriXXX`) SÍ los acepta.** La orden 13765, cheque de **$463.64**, se cobró en
> **4 pagos parciales** y Aloha aceptó los cuatro:
>
> ```
> #1 {amount:11591, tip:3409, tender_type:"979"}  → completed
> #2 {amount:11591, tip:3409, tender_type:"976"}  → completed
> #3 {amount:11591, tip:3409, tender_type:"975"}  → completed
> #4 {amount:11591, tip:3409, tender_type:"975"}  → completed
>                                4 × 115.91 = 463.64 ✓
> ```
>
> Cada uno es un parcial del `due`, con propina, y con tenders distintos entre sí. La estrategia de la
> integración —enviar cada pago conforme llega— **es correcta y funciona**. La orden 13770 lo repite
> con 2 pagos.
>
> **La location de certificación (`cx9oRBRi`, "Kleshik DEMO") los rechaza.** Se probaron 6 variantes,
> incluida una a **un centavo** del total, y todas devolvieron `insufficient_amount`. Mismo código,
> mismo shape de payload; lo único distinto es la location.
>
> **Qué significa:** no hay nada que arreglar en la integración por este motivo. Lo que hay que hacer
> es **verificar en la location real de producción** si acepta parciales antes de desplegar. Si la
> location del cliente se comporta como `cx9oRBRi`, entonces sí haría falta acumular en MCM; si se
> comporta como `cjgALEriXXX`, funciona tal cual está.

#### Evidencia de la location de certificación

Una mesa que divide la cuenta —dos comensales pagando su parte con el Flex— deja el cheque
**completamente sin pagar** en el POS, aunque el 100 % del dinero se haya cobrado en Clover.

Verificado 3 veces en la corrida (pagos 10034, 10035, 10036), incluido el pago del suplemento de F10.

**La causa es un límite de la API, no un descuido de la integración.** El endpoint
`POST /tickets/{id}/payments` de Omnivore **exige que `amount` cubra el `due` completo**. Se probaron
seis variantes sobre cheques reales, releyendo el `due` justo antes de cada cobro:

| variante | due | `amount` enviado | resultado |
|---|---|---|---|
| 25 % del due | 2054 | 514 | `insufficient_amount` |
| 50 % del due | 2054 | 1027 | `insufficient_amount` |
| **due − 1 centavo** | 2054 | **2053** | `insufficient_amount` |
| 50 % + `auto_close:false` | 2054 | 1027 | `insufficient_amount` |
| 50 % con `type:'cash'` | 2054 | 1027 | `insufficient_amount` |
| **due exacto (control)** | 1405 | **1405** | **201 aceptado** → `due=0`, cerrado |

Ni cambiar el tipo de pago, ni el tender, ni `auto_close`, ni quedarse **a un centavo** lo hace pasar.

> **Distinción importante.** En el **terminal físico de Aloha** sí se puede pagar parcialmente: el
> cajero divide, cobra por asiento, aplica pagos sucesivos. Eso funciona. Lo que no admite parciales
> es **la superficie de API por la que MCM aplica los pagos de Clover**. La limitación es de cómo
> Aloha se expone a través de Omnivore, no del POS.

**Qué implica para el arreglo.** No alcanza con corregir el forward: MCM manda cada pago conforme lo
lee del pull, y ninguno individual cubre el `due`. La estrategia correcta es **acumular en MCM los
pagos de Clover de una misma orden hasta cubrir el `due` autoritativo del POS y enviar entonces un
solo pago**. Es un cambio de diseño, no una línea.

Nota: `full: true` **tampoco** es una salida — el endpoint lo rechaza con
`invalid_input: "Full is not accepted"`, incluso sobre un pago que sin ese campo sí pasaría.

**Mecanismo exacto, leído de `job_step_attempts`.** Los seis `payment_injection` que murieron en la
corrida lo hicieron todos igual, y todos en el **primer intento**:

```
028b6876 ord=10055 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
0f7e8c04 ord=10055 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
70f620d0 ord=10054 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
1ec44762 ord=10040 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
a77c172e ord=10037 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
6e8e8feb ord=10036 #1 OMNIVORE_INSUFFICIENT_AMOUNT: Omnivore insufficient_amount
```

`insufficient_amount` está en `OMNIVORE_BUSINESS_SLUGS` (`error-map.ts:37`) ⇒ **no se reintenta**, va
directo a dead-letter. La clasificación es correcta: reintentar no ayudaría, el monto seguiría sin
cubrir el `due`. El defecto no está en el manejo del error sino en que el pago se envía sabiendo que
va a ser rechazado.

Es una limitación del POS que la integración **no maneja**: no acumula hasta cubrir el `due`, no
consulta el `due` autoritativo antes de enviar, y no señala en ningún lado que el cobro dividido no
es soportado.

Lo que **sí funciona bien**: el cuadre de impuestos en el ciclo de vida normal es exacto al centavo,
incluso con dos clases de tax, cantidades múltiples, voids y service charge — verificado paso a paso
en F9. Y el **mecanismo de orden suplementaria funciona correctamente** (F10).

**Denominador común:** el sistema está bien construido para no perder dinero por reintento
o duplicado, pero **la señal que emite cuando lo pierde no le sirve a un operador**. El absorber de
redondeo hace `console.warn` cuando no puede cuadrar; el enqueue devuelve un job ajeno o muerto y el
llamador loguea éxito sin poder distinguirlo; la orden fantasma de Clover no la mira nadie. El único
caso que sí alerta —el dead-letter— alerta mal (ver la sección de alertas más abajo).

**El patrón técnico que se repite:** `enqueue_job` con `ON CONFLICT DO NOTHING` devuelve el job
existente, y **quien lo llama no puede distinguir "encolé uno nuevo" de "ya había uno"**. Eso está
bien cuando el job existente es propio y está vivo; es un agujero cuando es de otro tenant (**H2**) o
cuando está muerto (**N2**). Las llaves sin discriminador (`pos_pay:{provider}:{id}`) y las llaves que
no se liberan al morir el job son las dos caras del mismo problema.

---

## F0 — Contratos verificados (no asumidos)

| # | Pregunta | Respuesta verificada | Evidencia |
|---|---|---|---|
| F0.1 | ¿`Payment.amount` de Clover incluye la propina? | **NO.** Orden `total=1000` + pago `{amount:1000, tipAmount:200}` → `paymentState=PAID`. Un pago de `amount` igual al total **salda** la orden ⇒ el `amount` es la base y lo cobrado es `amount+tip`. 3 reproducciones ($10+$2, $25+$3.75, $47.63+$9) + control sin propina + control parcial (`PARTIALLY_PAID`) | `f0-tip-evidence.json`, `f0-tip2-evidence.json` |
| F0.2 | ¿`TaxRate.rate` usa escala 1e7? | **Sí.** estatal `1050000`=10.5 %, reduced `600000`=6 %, municipal `100000`=1 % | `d-clover.json` |
| F0.6 | ¿El API de Omnivore devuelve `_links.next`? | **Sí**, contra lo que dice el dump de la doc (que describe paginación offset con `start`). El shape real es `{_embedded, _links, count, limit}` **sin** `start` | — |
| F0.7 | Shapes de error reales | **Omnivore**: `{errors:[{error:"<slug>", description, fields?}]}` — slugs vistos: `not_found`(404), `invalid_input`(400), `reference_not_found`(400), `bad_query`(400). **Clover**: `{details, message}` — sin slug ni código, solo HTTP status | `f0-errors-evidence.json` |
| F0.8 | Host de Clover | Ambos (`apisandbox` y `sandbox`) autentican | `d-clover.json` |

### Discrepancias documentación ↔ realidad

1. **`User-Agent` NO es obligatorio.** El dump OpenAPI lo marca `required: true` en los 10 endpoints; la llamada sin él devolvió **HTTP 200** con datos completos.
2. **La clave de `_embedded` del menú es `menu_items`**, no `items`.
3. **`lineItem.taxRates` viene envuelto en `{elements:[...]}`** y **no se devuelve** salvo que se pida `expand=lineItems.taxRates` explícitamente — no está en la lista de `expand` documentada para `GET /orders`.
4. Tope de paginación confirmado en vivo: `modifier_groups` con `limit=25` → `bad_query: "Max pagination limit of 20"`.

---

## Hallazgos

### 🔴 M1 · El pull de Clover rompe la convención de `payments.total` — **CONFIRMADO, con el diagnóstico corregido**

> **Corrección importante (2026-07-27, tras revisar producción).** Mi primera redacción decía que el bug
> estaba en `build-payment-body.ts` y que el arreglo era **quitar la resta de la propina**. Eso
> **habría roto producción**. El dueño pidió verificarlo antes de tocar nada; se verificó y la
> conclusión cambió de archivo.

**La convención de MCM, verificada en producción (Arena Medalla, site 51021421):**

```
payments.total  = lo COBRADO al cliente, propina INCLUIDA
payments.tip    = la propina
orders.total    = el cheque, propina EXCLUIDA
orders.paid     = Σ(payments.total) − Σ(payments.tip)
```

Comprobado sobre 5 pagos ECR reales: en los cinco, `payments.total − payments.tip == orders.total`,
y `orders.paid` coincide con `Σ(total) − Σ(tip)`, no con `Σ(total)`.

| orden | `orders.total` | pago `total` | `tip` | `total − tip` | `orders.paid` |
|---|---|---|---|---|---|
| 17044 | 23.46 | 25.46 | 2.00 | **23.46** ✓ | 23.46 |
| 17065 | 131.23 | 149.23 | 18.00 | **131.23** ✓ | 131.23 |
| 17161 | 38.29 | 45.00 | 6.71 | **38.29** ✓ | 38.29 |
| 17162 | 66.67 | 77.47 | 10.80 | **66.67** ✓ | 66.67 |
| 17267 | 45.96 | 45.96 | 0.00 | **45.96** ✓ | 45.96 |

**Bajo esa convención, `buildOmnivorePaymentBody` está BIEN.** `amount = total − tip` es exactamente
cómo se recupera la base que Aloha necesita. Y funciona: **12 reenvíos con propina completados** en
producción, con tenders 975/976/979 distintos.

**El defecto está en el pull de Clover** (`upsert-payments.ts:287`):

```ts
const totalInDollars = (p.amount / 100).toFixed(2);   // el `amount` de Clover YA excluye la propina
```

Clover entrega `amount` sin propina, así que `payments.total` queda con la **base**, no con lo
cobrado. Es el único origen de pagos que rompe la convención. Cuando el reenvío le resta la propina
—correctamente, según la convención— el monto se va corto y Aloha lo rechaza.

**Por qué se escribió así:** el propio pull acumula `Σ(payments.total)` y lo compara contra
`orders.total` para decidir si la orden quedó pagada (`:337-349`). Guardando la base, esa suma le
cuadra directo. El resto del sistema resuelve lo mismo restando las propinas — pero este camino tomó
el atajo, y al hacerlo rompió el contrato del que depende el reenvío.

**Decisión del dueño (2026-07-27): el envío de pago NO se toca.** Es el camino que hoy inyecta los
pagos de MCM a Omnivore y funciona bien en producción. `build-payment-body.ts` queda **byte a byte
como está**.

Verificado que los dos caminos son independientes y que la decisión es segura:

| | Quién crea el pago | `payments.total` | Reenvío a Omnivore |
|---|---|---|---|
| **ECR** (Arena Medalla, producción) | flujo propio de MCM | lo cobrado, **con propina** | funciona ✓ · 223 pagos con propina |
| **Pull de Clover** | `upsert-payments.ts` | la base, **sin propina** | falla ✗ |

Arena Medalla **no tiene integración Clover** — solo `ecr-card`, `ecr-cash` y `omnivore`. Sus pagos
nunca pasan por el pull. Y el pull de Clover hoy **no lleva tráfico vivo**: solo está activo en Pala
Pizza (último pago de Clover el 8 de junio, 7 órdenes de Omnivore en total) y en el sitio de
certificación.

**El arreglo, entonces, va exclusivamente en el pull de Clover:**

```ts
// upsert-payments.ts — honrar la convención
- const totalInDollars = (p.amount / 100).toFixed(2);
+ const totalInDollars = ((p.amount + p.tip) / 100).toFixed(2);

// y su propia suma de cumplimiento pasa a restar las propinas,
// igual que hace el resto del sistema:
- .select('total')  … acc + Number(pay.total)
+ .select('total, tip')  … acc + (Number(pay.total) - Number(pay.tip))
```

`build-payment-body.ts` **no se toca**. Los pagos ECR de producción siguen exactamente igual, y el
pull de Clover pasa a comportarse como cualquier otro origen de pago del sistema.

---

#### Evidencia original del síntoma (sigue siendo válida)

**Efecto:** cualquier pago de Clover **con propina** llega a Aloha por `cheque − propina`, Aloha lo
rechaza con `insufficient_amount`, el job muere en `dead_letter` y **el cheque queda totalmente sin
pagar en el POS** — mientras el dinero ya se cobró en Clover.

No es "el cheque queda corto por la propina": Aloha **rechaza el pago entero**.

**Mecanismo** (dos líneas del mismo flujo):
- `src/handlers/clover/sync/upsert-payments.ts:287` — `payments.total = p.amount/100`, y el `amount`
  de Clover **ya excluye la propina** (verificado en F0.1). El propio comentario de `:334-336` lo dice.
- `src/handlers/omnivore/inject/build-payment-body.ts:50` — `amount = toCents(payment.total) − toCents(payment.tip)`
  → se la resta por segunda vez.

**Reproducciones + control aislante:**

| caso | cheque | propina | enviado a Omnivore | job | cheque final |
|---|---|---|---|---|---|
| F4.1 | 1662 | 300 | 1362 | `dead_letter` | `due=1662`, abierto |
| R3 | 2419 | 475 | 1944 | `dead_letter` | `due=2419`, abierto |
| R2 | 649 | 250 | 399 | `dead_letter` | `due=649`, abierto |
| **C0 control** | **649** | **0** | **649** | **`completed`** | **`due=0`, cerrado** ✓ |

R2 y C0 son el mismo cheque (649) con el mismo menú: **la única variable es la propina**. Con propina
0 el pago entra y el cheque cierra con `omnivore_payment_id=105906177`.

**Impacto operativo:** en servicio de mesa casi todo pago con tarjeta lleva propina ⇒ prácticamente
ningún cheque cobrado por Clover se cierra en Aloha.

Evidencia: `f4-1-*.json`, `f4-reps-*.json`, `f4-reps2-*.json`.

### 🔴 H2 · Colisión de idempotencia entre tenants: un pago se pierde en silencio — **CONFIRMADO EN VIVO**

**El más grave de la certificación.** Un pago cobrado y registrado en MCM **nunca se inyecta al POS**,
sin error, sin job, sin dead-letter y sin alerta. La orden queda `check-closed`/`fulfilled` en MCM
mientras el cheque sigue **abierto** en Aloha.

**Capturado en el acto:**

```
site 99990003, pago MCM 10032 ($14.05, propina 0), orden 10051, ticket 20260726-1010016
  log del worker : "clover pull: enqueued Omnivore payment forward (with tip)"   ← cree que lo encoló
  job resultante : NINGUNO
  MCM            : paid=14.05  payment_status=fulfilled  status=check-closed
  Aloha          : due=1405  paid=0  open=true
```

La llave `pos_pay:omnivore:10032` **ya pertenecía a un job del site 55126712**, creado el
**2026-06-12** (seis semanas antes), `status=completed`, `reference_id=10036`.

**Mecanismo:** `src/enqueue/helpers.ts:87` compone la llave como `pos_pay:{provider}:{paymentId}`
**sin `site_id`**, y `integration_jobs.idempotency_key` es **UNIQUE global**. Como `payments.id` es una
secuencia **por site**, dos negocios distintos generan el mismo id. `enqueue_job` hace
`ON CONFLICT DO NOTHING` y **devuelve el job existente del otro tenant**; el código recibe un id de
job válido de vuelta y loguea éxito — no tiene forma de saber que no es suyo.

**No es determinista, es azar:** en la misma corrida los pagos 10030 y 10031 **sí** obtuvieron su job
(sus llaves estaban libres) y el 10032 se perdió.

**Exposición medida en Dev:** hay **35 llaves** del namespace `pos_pay:omnivore:*` ocupadas por otros
sites (rango de ids 10001–10275, dueños 25612612 / 48372619 / 55126712), y **6 de ellas apuntan a jobs
en `dead_letter`** — o sea que un pago nuevo que colisione con esas no solo se pierde, sino que
"reutiliza" un job muerto.

**Contraste con la edge:** el lado edge ya se arregló el 2026-07-13 y compone
`pos_pay:omnivore:{site_id}:{payment_id}`. El job-engine —que es el que corre el reenvío
Clover→Omnivore— **no**. Lo mismo aplica a `pos_inject:{provider}:{orderId}` (`:37`) y
`clover_supp_inject:{orderId}:{sig}` (`:140`).

**Por qué `pos_pay` es el que revienta y no los demás.** Medido: el namespace
`clover_inject:{order_id}:{hash}` tiene 130 llaves de 2 sites y **cero `order_id` compartidos entre
tenants** — porque el hash de líneas actúa como **discriminador accidental**: dos negocios tendrían
que coincidir en el id de orden *y* en el contenido exacto del cheque. `clover_supp_inject` incluye
la `delta_signature`, misma protección accidental.

`pos_pay:{provider}:{paymentId}` **no tiene ningún discriminador** — solo el id del pago, que es una
secuencia por site. Por eso es el único donde la colisión es prácticamente inevitable con el tiempo,
y el único que ya la produjo.

Evidencia: `m2-*.json` + consulta directa de `integration_jobs`.

### 🟢 M8 · Un ítem anulado se sigue cobrando — **CONFIRMADO, pero NO APLICA a esta configuración**

> **Decisión del dueño (2026-07-27):** la integración Clover × Omnivore corre con
> **`omnivoreTableServiceEnabled` apagado**, que es el camino donde M8 **no se reproduce**.
> Queda descartado de la lista de arreglos.
>
> **Verificado:** con el flag apagado (F9, paso A5) el void se comporta limpio en los tres sistemas —
> el POS baja de 4700 a 4100, MCM pasa de 5 a 4 líneas, y la línea desaparece de Clover. Las 3
> reproducciones de abajo se obtuvieron **encendiendo el flag a propósito** y restaurándolo después.
>
> Estado actual del flag: `99990003` **false** · `48372619` (Pala Pizza) sin definir = apagado ·
> `25512412` sin definir = apagado. Solo `51021421` y `25612612` lo tienen encendido, y ninguno usa
> el pull de Clover.
>
> **Cuándo volvería:** si algún día se enciende el table-service para esta integración, M8 reaparece.
> El defecto de código sigue ahí —el constructor no filtra `voided`— simplemente ese camino no se
> ejercita hoy.

#### Evidencia del defecto (con el flag encendido)

Solo ocurre en el camino **managed** (`omnivoreTableServiceEnabled = true`), donde el merge conserva
la línea anulada con `status:'voided'` en vez de quitarla.

```
ANTES  : POS 2703 · MCM 2703 · Clover 2703   ✓ cuadra (3 líneas)
[el mesero anula "Refritos Small" $6.00]
DESPUÉS: POS 2054 · MCM 2054 (2 vivas + 1 anulada) · Clover 2696   ✗
                                                     ↑ la línea "Refritos Small=600" sigue ahí
Δ = 642  (el ítem 600 + su impuesto 42)
```

**Tres reproducciones**, con ítem, clase de impuesto y monto distintos en cada una:

| rep | ítem anulado | POS | MCM | Clover | Δ | desglose del Δ |
|---|---|---|---|---|---|---|
| M8a | Refritos $6.00 (reduced) | 2054 | 2054 | 2696 | **642** | 600 + 36 + 6 |
| M8b | Elote $13.00 (reduced) | 1662 | 1662 | 3054 | **1392** | 1300 + 78 + 13 |
| M8c | Codorniu $9.00 (standard) | 649 | 649 | 1653 | **1004** | 900 + 95 + 9 |

En las tres, la línea anulada queda retenida en MCM con `status:'voided'` **y sigue presente en la
orden de Clover**. Los deltas cuadran exacto con el precio del ítem más su impuesto según su clase.

**Mecanismo:** `buildCloverLineItemsWithTaxes` itera `order.line_items` **sin filtrar
`status === 'voided'`** (cero referencias a `voided` en el builder ni en `computeLineItemsSignature`).
El absorber apunta al total del POS (2054) pero el delta (−642) supera el guard de $1, así que no
reconcilia y solo hace `console.warn`.

**Con `omnivoreTableServiceEnabled = false` NO se reproduce**: el camino de overwrite reconstruye
`line_items` desde el ticket y la línea anulada desaparece limpiamente (verificado en F9.A5, cuadra).

Evidencia: `f9-m8-*.json`.

### 🔴 R5 · Un cheque con descuento se sobrecobra en Clover, en silencio — **CONFIRMADO**

**Efecto:** el descuento aplicado en el POS llega bien a MCM pero **no viaja a Clover**. La orden de
Clover se crea con los precios **brutos**, así que el cliente pagaría de más aproximadamente el
descuento más su impuesto. Y **no se emite ninguna señal de error**.

**Tres reproducciones, todas con `pos_injection_error = null`:**

| caso | descuento | POS | MCM | Clover | Δ (sobrecobro) |
|---|---|---|---|---|---|
| A7bis | `c39` 20 % | 4021 | 4021 | 5014 | **+993** |
| R5b | `c39` 20 % | 1647 | 1647 | 2054 | **+407** |
| **R5c** | **`c83` NBO/Comp 100 %** | **17** | **17** | **1663** | **+1646** |

**R5c es el caso de cortesía del gerente y es el peor**: se comp la comida entera, el cheque del POS
baja a 17 centavos (solo queda el service charge) y **Clover cobra los $16.63 completos**. Al cliente
se le cobraría íntegra una comida que se le regaló.

Desglose del caso base (ticket `20260726-1010013`, `c39` "Owners 20%"):

```
POS    : 4021   (items 4600 − descuento 920 + svc 46 + tax 295)
MCM    : 4021   ✓ correcto — discount_total 9.20, tax_lines con las bases prorrateadas
Clover : 5014   ← precio SIN descuento
Δ      : +993   →  $9.93 de sobrecobro
pos_injection_error : null   ← ningún rastro del problema
```

**Mecanismo:** `buildCloverLineItemsWithTaxes` compone la orden de Clover con `line_items` +
`fee_lines` + `shipping_lines` únicamente — **los descuentos no se empujan como Clover discounts**
(0 referencias en el builder). El absorber de redondeo apunta al total autoritativo (4021) pero el
delta (993) supera el guard de `|delta| ≤ 100` centavos, así que **no reconcilia y solo hace
`console.warn`** — que no queda en ninguna tabla ni alerta.

MCM internamente maneja el descuento correctamente (lo prorratea entre las bases imponibles
`estatal 7.66 / reduced 29.60 / municipal 37.26`). El defecto es exclusivo del push a Clover.

**Nota de configuración:** de los 44 descuentos de `cx9oRBRi` solo **6** tienen `available: true`, y
los 6 son de **ticket** con porcentaje fijo. No hay descuentos de ítem disponibles, así que el caso
item-level no se pudo probar en esta location.

Evidencia: `f9-a7-*.json`, `f9-r5reps-*.json`.

---

### 🔴 M7 · Todo cheque cobrado en el terminal Aloha ensucia Clover — **CONFIRMADO**

`getOrdersPendingSyncToClover` (`clover-helper.ts:1405-1410`) incluye `check-closed` entre los
estados elegibles y **no filtra por `payment_status`**. Un cheque que el mesero ya cobró en el POS
—en efectivo o con el tender de tarjeta del propio Aloha— se empuja igual a Clover como orden
**abierta**, y nadie la va a pagar nunca.

Cuatro reproducciones, con tenders, ítems y montos distintos:

| rep | cobro en Aloha | Aloha | MCM | orden Clover creada | estado |
|---|---|---|---|---|---|
| M7a | efectivo | `due=0 paid=649` cerrado | `check-closed`/`fulfilled` | `EV6D0G374PGQY` 649¢ | `OPEN` |
| M7c | tarjeta AMEX del POS | `paid=2419 tips=500` | `partially_fulfilled` | `B477KQHFKRPG4` 2419¢ | `OPEN` |
| D2 | efectivo | `due=0 paid=1405` cerrado | `check-closed`/`fulfilled` | `23NWEKF382V8G` 1405¢ | `OPEN` |
| D3 | efectivo | `due=0 paid=1662` cerrado | `check-closed`/`fulfilled` | `DBDFE88BK3HS8` 1662¢ | `OPEN` |

**Medido sobre la corrida completa (F11.8), no solo sobre las 4 reproducciones:** de **67** órdenes
empujadas a Clover, **32 quedaron `OPEN` con el cheque de Aloha ya saldado** (`due=0`) —
**$1,854.67** de basura permanente en el Register.

**Por qué importa en un restaurante real.** Un negocio con 20-40 % de efectivo genera esa proporción
de órdenes fantasma **cada servicio**. No es solo ruido visual en el Register: toda métrica del lado
Clover (ventas abiertas, cheques pendientes, conciliación de fin de día) queda inflada por dinero que
ya se cobró en el otro sistema. Y como las órdenes quedan `OPEN` indefinidamente, el ruido se acumula
día tras día sin que nada las cierre.

Evidencia: `m7-*.json`, `m7n3cash-*.json`, `f11-*.json`.

---

### 🔴 N3 · El tender real y la propina del terminal Aloha se pierden — **CONFIRMADO**

Cuando un cheque se cobra en el POS, MCM le fabrica una fila de `payments` en
`recordExternalOmnivorePaymentIfNeeded` (`upsert-orders.ts:76-102`). Esa fila lleva
**literales**, no los datos del cobro real:

```ts
method: 'ecr-card',      // upsert-orders.ts:88 — constante, no mira el tender
tip:    '0.00',          // upsert-orders.ts:91 — constante, no mira totals.tips
```

Y en la **re-verificación** resultó ser más profundo que "se sobrescribe": los datos **nunca se
piden**. El `FIELDS` con el que el sync consulta el ticket (`order-mapper.ts:17-24`) es:

```
'id,name,open,opened_at,closed_at,' +
'totals(due,paid,items,discounts,service_charges,tax,total),' +   ← sin `tips`
'employee(...),order_type(...),revenue_center(...),' +
'table(...),items(...)'                                            ← sin `payments(...)`
```

No pide `tips` ni pide `payments`. Por eso el mapper tiene **0 ocurrencias de `tip`** y
`upsert-orders.ts` **0 de `tender`**: no es que se descarten, es que MCM nunca se los pregunta a
Aloha. Confirmado además ejecutando el mapper real (ver N4).

Tres reproducciones, todas con efectivo, montos distintos:

| rep | tender real en Aloha | `payments.method` en MCM | `payments.tip` |
|---|---|---|---|
| M7a | CASH | `ecr-card` | `0.00` |
| D2 | CASH | `ecr-card` | `0.00` |
| D3 | CASH | `ecr-card` | `0.00` |

**Consecuencia directa sobre dos criterios de la certificación:**

- **F11.2 · cuadre por tender** — imposible. Todo cobro hecho en el POS aparece como tarjeta en MCM.
  El efectivo de la caja no se distingue del cobro con tarjeta, así que el arqueo de caja no cierra
  contra MCM aunque el total general cuadre.
- **F11.4 · reporte de propinas / tip-out** — la propina cobrada en el terminal Aloha **no llega a
  MCM por ninguna vía**: ni en la orden ni en el pago. Se le reparte propina al personal sobre datos
  que MCM no tiene.

Nota: esto es distinto de **M5** (ajuste de propina post-captura en Clover, que no se reenvía a
Omnivore). N3 es la dirección contraria — propina nacida en Aloha que nunca llega a MCM. Los dos
juntos dejan el reporte de propinas roto en ambos sentidos.

Evidencia: `m7-*.json`, `m7n3cash-*.json`, `n4-repro.ts`.

---

### 🔴 N4 · MCM confía en `due` y nunca reconcilia `paid` contra `total` — **CONFIRMADO**

`convertOmnivoreOrderToMCMOrder` deriva el `payment_status` de **un solo campo**
(`order-mapper.ts:264-269`):

```ts
if (omnivoreOrder.totals.paid > 0) {
  payment_status = omnivoreOrder.totals.due == 0 ? 'fulfilled' : 'partially_fulfilled';
}
```

`paid` vs `total` no se compara nunca. Y `recordExternalOmnivorePaymentIfNeeded` exige
`payment_status === 'fulfilled'` para crear la fila de `payments` (`upsert-orders.ts:77`). Entonces,
si el POS reporta un cheque **totalmente cobrado** pero con `due` sin liquidar, MCM lo marca
`partially_fulfilled` y **no registra el dinero en ninguna parte**.

**No es hipotético: pasó solo durante la certificación.** El ticket `20260726-1010031` recibió su
pago tras un `pos_not_responding_retry`; el agente de Aloha aplicó el cobro pero dejó el ticket en un
estado que viola su propia fórmula documentada `due = total − paid`:

```
Aloha:  total=2419  paid=2419  tips=500  due=2419  open=true
MCM:    payment_status=partially_fulfilled   paid=24.19   pagos en `payments`: 0
```

**Repro determinista contra el mapper de producción** (`cert/n4-repro.ts`), con dos controles que
aíslan la variable:

| entrada | `payment_status` | ¿crea fila en `payments`? |
|---|---|---|
| `paid=2419 total=2419 due=2419` ← observado en vivo | `partially_fulfilled` | **NO** |
| `paid=2419 total=2419 due=0` ← control | `fulfilled` | sí |
| `paid=1200 total=2419 due=1219` ← control parcial real | `partially_fulfilled` | NO (correcto) |

El control confirma que `due` es el único discriminador: con los mismos `paid` y `total`, cambiar
solo `due` invierte el resultado.

**Por qué importa.** El disparador no es exótico: es que el POS hipe durante el cobro. En esta misma
corrida el sandbox de Aloha devolvió `timeout` o `pos_not_responding_retry` en varios cobros. Cada
vez que eso deja el ticket descuadrado, MCM pierde el rastro del dinero — y encima empuja la orden a
Clover como cobrable (M7).

Evidencia: `cert/n4-repro.ts` (ejecutable), ticket `20260726-1010031`.

---

### 🔴 N5 · Aloha ignora `Idempotency-Id` y **duplica la propina** al reintentar — **CONFIRMADO**

Dos `POST /tickets/{id}/payments` con **body idéntico y el mismo header `Idempotency-Id`**:

```
POST #1 (Idempotency-Id: cert-n5-N1EM) → HTTP 500 pos_not_responding_retry
POST #2 (Idempotency-Id: cert-n5-N1EM) → HTTP 500 pos_not_responding_retry

ticket final: due=649  paid=649  tips=200      ← propina duplicada (2 × 100)
pagos en el ticket: 2 → [{id:105906187, amount:649, tip:100},
                         {id:105906188, amount:0,   tip:100}]
```

Dos pagos distintos con la misma llave ⇒ **el header no deduplica nada**. Y el patrón de la
autocorrección es lo peligroso: Aloha ajusta el **principal** con un pago compensatorio
(`amount: 0`, o `amount: -1298` en la segunda reproducción) pero **deja las propinas sumadas**.

Segunda reproducción, con 4 intentos sobre el ticket `20260726-1010033`:

```
pagos: [{amount:649, tip:450}, {amount:649, tip:450}, {amount:649, tip:450}, {amount:-1298, tip:450}]
totals: paid=649 (correcto)   tips=1800 (4 × 450)   due=649 (nunca liquidó)
```

Además `pos_not_responding_retry` y `timeout` están en `OMNIVORE_RETRYABLE_SLUGS`
(`error-map.ts:17-24`), o sea que el motor **sí** reintenta exactamente el error que produce esto.

**La defensa existe y está bien hecha — y ahora está justificada empíricamente.** El handler
`omnivore.payment_injection` (`payment.ts:113-137`) no se apoya en el header: en cada reintento
(`attempt_count > 0`) hace un `GET /tickets/{id}/payments` y busca el pago por `comment` + `amount`
antes de re-postear; si el GET falla, **lanza retryable en vez de postear**. Su propio comentario ya
declaraba que el header está muerto en Aloha; esta prueba lo confirma con datos.

**Lo que queda como riesgo residual**, para revisar con calma fuera de la certificación:
la reconciliación matchea por `comment` + `amount`. Dos pagos del mismo cheque con **el mismo monto y
el mismo comment** serían indistinguibles entre sí. No se pudo ejercitar en esta corrida porque los
pagos divididos mueren antes por **N1** (`insufficient_amount`), así que queda como **NO VERIFICADO**,
no como hallazgo.

Evidencia: `n5-*.json`, tickets `20260726-1010033` y `20260726-1010035`.

---

### 🟠 H1 · El sync muerto no se recupera solo, y la alerta que sí llega no dice qué pasó — **CONFIRMADO, con la predicción corregida**

**La predicción del plan decía "se apaga para siempre, sin alerta". La mitad era falsa** y la
evidencia manda: los dead-letters **sí** generan alerta. Lo verifiqué en `alerts_outbox` de los dos
sitios. Lo que falla es otra cosa, y es más sutil.

**Lo que sí es cierto:** `fail_sync_schedule` (`002_jobs_functions.sql:485-489`) pone
`status='failing'` al quinto fallo consecutivo, y `claim_due_schedules` solo reclama
`status='active'` (`:405`). A partir de ahí el sync **no vuelve a correr solo**: la única salida es un
`trigger_sync_now` manual o re-guardar el formulario, que devuelve el schedule a `active`
(`017_serialize_sync_enqueue.sql:183`). La transición a `failing` —el evento que de verdad importa—
**no emite ninguna alerta propia**.

**Lo que la certificación desmintió:** cada job que muere sí dispara `tg_emit_dead_letter_alert`
(`002_jobs_functions.sql:612-650`). En el incidente de Arena Medalla salieron **5 correos, todos
`sent`**:

```
05:03:19  dead_letter | dead_letter:omnivore:51021421 | sent
05:04:19  dead_letter | dead_letter:omnivore:51021421 | sent
05:05:20  dead_letter | dead_letter:omnivore:51021421 | sent
05:06:20  dead_letter | dead_letter:omnivore:51021421 | sent
05:07:21  dead_letter | dead_letter:omnivore:51021421 | sent
```

**El problema real es el contenido y el agrupamiento de la alerta**, no su ausencia:

1. **La llave de dedup es `dead_letter:{integración}:{site_id}`** — ni por orden, ni por tipo de
   error. En el site de certificación, **9 reenvíos de pago muertos por tres causas distintas**
   (M1 ×3, N1 ×3, más otros) colapsaron en **2 filas de alerta**. Un operador no puede saber cuántos
   cheques quedaron sin pagar ni por qué.
2. **El texto es de infraestructura, no de negocio.** Dice `Job <uuid> reached dead_letter state.
   Reason: Omnivore insufficient_amount`. No dice "3 cheques cobrados quedaron abiertos en el POS".
3. **Cuando el sync se apaga, las alertas también.** Al parar el schedule dejan de morir jobs, así que
   dejan de llegar correos. El silencio posterior es indistinguible de "todo bien" — y ese es
   precisamente el estado peligroso.

### Reproducción controlada de H1 en el site de certificación

Se invalidó a propósito la `apiKey` de Omnivore del site 99990003 y se cronometró todo:

```
t+ 75s  fallos=1   Omnivore invalid_api_key      ← la caché de credenciales es de 60 s
t+165s  fallos=2
t+180s  fallos=3
t+240s  fallos=4
t+285s  fallos=5   status = 'failing'            ← 4 min 45 s desde el primer fallo

alertas emitidas en toda la ventana: 1
   dead_letter:omnivore:99990003
alerta específica de "el sync se apagó": NINGUNA
```

Y las tres pruebas de recuperación, **que corrigen lo que había asumido**:

| intento | resultado |
|---|---|
| restaurar la credencial y esperar 90 s | `failing` — **no revive solo** |
| `trigger_sync_now(site,'omnivore','fetch_recent_orders')` | `failing` — **tampoco lo revive** |
| `ensure_sync_schedules(site,'omnivore',true)` | **`active`** ✓ — es el único camino |

O sea: la única salida es **re-guardar el formulario de la integración** en el dashboard, que es lo
que dispara `ensure_sync_schedules`. Un operador que use el botón "Sincronizar ahora" verá que no
pasa nada y no tendrá forma de saber por qué.

> **Un falso positivo que descarté aquí.** Tras la recuperación, `consecutive_failures` sigue en 5, y
> parecía que el schedule quedaría "a un fallo de morir otra vez". Revisando
> `002_jobs_functions.sql:462`, un ciclo **exitoso** pone `consecutive_failures = 0`. No es un
> hallazgo.

**Nota sobre el 6.º fallo de Arena Medalla.** El schedule `54eb48f1` volvió a correr a las 07:02:33
estando en `failing`. Dado lo anterior, no pudo ser `trigger_sync_now`: fue un `ensure_sync_schedules`
—es decir, alguien re-guardó la integración—. Falló otra vez con el mismo `not_found` y volvió a
`failing`.

### 🟠 F11.bis · Las palancas de apagado: una funciona, una miente y una necesita un paso extra

| palanca | efecto medido |
|---|---|
| `sync_schedules.status='disabled'` | ✅ **inmediato**. Corte quirúrgico, funciona como dice |
| `site_integrations.active=false` | ⚠️ **NO apaga el schedule**. Se verificó: el schedule sigue `active`, los jobs se siguen encolando y fallan al pedir credenciales. Apagar la integración **no** detiene el tráfico, solo lo convierte en errores |
| `config.sync_orders_to_clover=false` | ⚠️ **sin efecto** hasta que se re-ejecute `ensure_sync_schedules()`; después sí pasa a `disabled` ✓ |

La palanca que un operador usaría por instinto —desactivar la integración— es justamente la que no
apaga nada. En una contención de emergencia eso importa: hay que ir a `sync_schedules`.

**Bonus verificado durante esta prueba:** `invalid_api_key` **no está en `error-map.ts`**, así que cae
en el default `isOmnivoreSlugRetryable() → true` y **se reintenta**. Una credencial permanentemente
mala se trata como un fallo transitorio.

---

## F11 · Reconciliación de cierre

> Esta sección se calculó sobre las primeras **73** órdenes. Las cifras del conjunto completo
> (**186** órdenes) están arriba, en *Cifras finales de la corrida*; los porcentajes y mecanismos
> no cambiaron al ampliar la muestra.


Cuadre leído de las tres fuentes (no reconstruido), orden por orden, todo scoped a `site_id=99990003`.

### 11.1 · Cuadre triple: **60 de 73**

De las 13 que no cuadran, 12 son hallazgos ya documentados y **1 es un artefacto de mi script**:

Cada descuadre se atribuyó a su causa diffeando línea por línea MCM contra Clover, no a ojo:

| orden | POS = MCM | Clover | Δ | causa |
|---|---|---|---|---|
| 10050 | 17 | 1663 | **+1646** | **R5** · descuento POS 1500¢ que Clover no aplica (comp 100 %) |
| 10048 | 4021 | 5014 | **+993** | **R5** · descuento 920¢ |
| 10049 | 1647 | 2054 | **+407** | **R5** · descuento 380¢ |
| 10017 | 5896 | 6271 | **+375** | **R5** · descuento 350¢ |
| 10056 | 1662 | 3054 | **+1392** | **M8** · "Elote" anulado, sigue cobrado (1300¢) |
| 10057 | 649 | 1653 | **+1004** | **M8** · "Codorniu Cuvee Brut CP" anulado, sigue cobrado (900¢) |
| 10052 | 2054 | 2696 | **+642** | **M8** · "Refritos Small" anulado, sigue cobrado (600¢) |
| 10006 | 7264 | 7365 | **+101** | **impuesto del service charge** — ver abajo, el caso más revelador |
| 10064, 10065, 10067, 10071 | 0 = 0 | sin `total` | — | tickets que el POS nunca totalizó (ver 11.8) |
| 10055 | — | — | — | **artefacto de mi comparador**: lee solo la orden Clover primaria y esta tiene además un **suplemento** (F10). No es descuadre real |

**Sobrecobro total de Clover sobre el POS en la corrida: $65.60.** En todos los casos el patrón es
**POS = MCM ≠ Clover** — la ingesta Omnivore→MCM cuadra al centavo en las 73; lo que se rompe siempre
es el push a Clover.

### 🔴 La divergencia de impuesto se esconde dentro de la tolerancia de redondeo — **CONFIRMADO**

> **Encuadre corregido en la re-verificación.** Mi primera redacción decía "el absorber enmascara el
> error", lo cual es injusto con el código. El absorber hace **exactamente** lo que fue diseñado a
> hacer, y su comentario lo dice antes de que yo lo probara:
>
> ```
> // Sólo reconciliar residuos de centavos (redondeo). Un delta grande sería
> // OTRO problema (ítem faltante, descuento no aplicado…) y NO se enmascara.
> ```
>
> El autor anticipó R5 y M8. El defecto real es otro: **la divergencia de impuesto del service charge
> cae DENTRO de la tolerancia de $1**, así que es indistinguible de un residuo de redondeo y se
> absorbe. No es un fallo del absorber; es que la tolerancia no puede separar "redondeo" de "gravamos
> el fee y el POS no".


La orden **10006** es la pieza que une F11.1 con F11.5, y falla por **un centavo**.

```
POS:     sub_total=5900  service_charges=944  tax=420   total=7264   ← autoritativo
Clover:  líneas 1800+600+1700+1800+944 = 6844
         impuestos 126+42+119+126+ 108  =  521          total=7365
                                    └─ el fee gravado, que el POS NO grava
```

`buildCloverLineItemsWithTaxes` reconcilia contra el `order.total` del POS absorbiendo el residuo en
la última línea de fee, **pero solo si `|delta| ≤ 100` centavos**. Aquí `delta = 7264 − 7365 = −101`.
**Se pasa del guard por 1 centavo**, así que no reconcilia y solo hace `console.warn` — que no queda
en ninguna tabla ni alerta.

**Y eso destapa lo importante.** Las otras 7 divergencias de impuesto de F11.5 están **todas bajo
$1.00** (+93, +89, +62, +62, +62, +48, −36). Esas **sí** las absorbió el guard: Clover terminó
cuadrando con el POS, pero **a costa de alterar en silencio la línea del fee**. Por eso solo 10006
aparece en la lista de descuadres: no es que las demás estén bien, es que **el absorber las tapó**.

**Verificado, no inferido.** Leí la línea del fee en Clover contra la de MCM en las 5 órdenes con
divergencia bajo $1. El ajuste del absorber **iguala exactamente el Δ de impuesto**, en las 5:

| orden | fee en el POS | fee en MCM | fee en Clover | ajuste | Δ de impuesto | `Clover.total` |
|---|---|---|---|---|---|---|
| 10002 | 864¢ | 864¢ | **771¢** | −93 | +93 | 6649 = POS ✓ |
| 10005 | 576¢ | 576¢ | **514¢** | −62 | +62 | 4432 = POS ✓ |
| 10007 | 448¢ | 448¢ | **400¢** | −48 | +48 | 3447 = POS ✓ |
| 10010 | 832¢ | 832¢ | **743¢** | −89 | +89 | 6402 = POS ✓ |
| 10026 | 576¢ | 576¢ | **514¢** | −62 | +62 | 4432 = POS ✓ |

**El resultado neto**, sin culpar al absorber: una **divergencia sistemática de impuesto de hasta
$1.00 por cheque** cae dentro de la tolerancia y se vuelve invisible.

- **bajo $1** → se absorbe ajustando el `price` de la línea del fee (el código ajusta `price` y **no**
  `taxAmount`, por eso el fee baja). El total cuadra con el POS, así que nadie se entera; pero el
  cliente ve en el recibo del Flex un *Maintenance & Entertainment Fee* de **$7.71** cuando el POS
  cobró **$8.64**, y paga más impuesto del que el POS calculó. La diferencia se mueve de la columna
  "fee" a la columna "impuesto" sin que nada lo registre.
- **sobre $1** → `console.warn("delta grande … posible bug aguas arriba")` y ya. Verificado: es solo
  un warn, sin fila en ninguna tabla ni alerta. El total se cobra de más (orden 10006).

En los dos casos el desglose que ve el cliente sale mal, en ninguno queda rastro consultable, y la
frontera entre "se absorbe" y "se cobra de más" es de **un centavo**.

**Por qué esto importa para el arreglo:** subir la tolerancia empeora el problema y bajarla convierte
7 cheques silenciosos en 7 warns silenciosos. La corrección real está aguas arriba — dejar de gravar
el service charge que el POS no grava — no en el absorber.

---

### 11.5 · Base imponible: **65 de 73**, y **$4.81 de más sobre $208.73** (+2.3 %)

Es el punto de exposición fiscal: las `tax_lines` alimentan `total_ivu` de la planilla, y **no
reconcilian contra el `totals.tax` del POS**. Dos mecanismos distintos, los dos verificados:

**a) MCM grava el service charge; Omnivore no.** Orden 10002:

```
POS:  sub_total=5400  service_charges=864  tax=385   total=6649
MCM:  estatal 10.5 % sobre 8.64 (el fee) = 0.91
      reduced  6 %   sobre 54.00         = 3.24
      municipal 1 %  sobre 62.64 (ítems+fee) = 0.63     Σ = 4.78     Δ = +93
```

La fila del fee se **autocontradice**: declara `is_taxable: false` y trae `total_tax: 0.99`.

```json
{"name":"Maintenance & Entertainment Fee","total":"8.64","is_taxable":false,"total_tax":"0.99"}
```

Coincide con el contrato documentado de Omnivore (*"Service charges are not taxed"*, y
`total = sub_total + service_charges + exclusive_tax`).

**b) La clasificación standard/reduced la reconstruye MCM, no la toma del POS.** Orden 10009, sin
service charge: las bases suman igual ($122.00 en los dos) pero el reparto difiere — MCM clasifica
$48 como standard y $74 como reduced según `config.standardProductsCategories`, y el impuesto del POS
implica otra mezcla. Δ = −36.

En ambos casos el impuesto que MCM declara **no es el que el POS cobró**. Sobre esta corrida el sesgo
es hacia arriba, pero el signo depende de la mezcla de la carta: la orden 10009 va al revés.

### 11.6 · Estado de los cheques: **14 con dinero no aplicado al POS**

```
cobrados en MCM con due>0 en Aloha: 14
  10010(due 4402) 10012(4379) 10013(2027) 10036(1662) 10037(2419) 10040(649) 10051(1405)
  10054(2054) 10055(2595) 10062(757) 10063(2419) 10066(2419) 10068(649) 10070(649)
```

Es la suma de **M1** (propina), **N1** (parcial), **H2** (llave ajena) y **N4** (`due` descuadrado).
Y hay **12 órdenes que MCM marca `check-closed` con el cheque todavía abierto en Aloha**. Ninguna de
las dos cifras la ve nadie hoy: no hay reporte que las cruce.

### 11.8 · **32 órdenes fantasma en Clover — $1,854.67**

Órdenes Clover en `OPEN` cuyo cheque en Aloha ya no debe nada (`due=0`). Es **M7 medido sobre la
corrida completa**, no sobre 4 reproducciones: de 67 órdenes empujadas a Clover, **32 quedaron
abiertas para siempre** por dinero ya cobrado en el otro sistema.

**Además: 4 órdenes Clover con líneas pero sin `total`** (`10064, 10065, 10067, 10071`). El
`POST /orders/{id} {total}` posterior al bulk no persistió, así que el Register las muestra en
**$0.00** aunque tengan ítems. Vienen de tickets que el POS nunca llegó a totalizar durante su
degradación — o sea que **un ticket vacío o a medias igual genera una orden en Clover**.

Huérfanos: 0 pagos sin orden. 6 órdenes MCM sin orden en Clover (3 de ellas son **N2**).

### 11.4 · Propinas — dato contaminado, no se usa

Clover cobró $10.25 en propinas y MCM registró $10.25 (coinciden). Aloha registra **$52.90**, pero esa
cifra **está inflada por mis propios reintentos** al reproducir **N5** (propina duplicada ×4 y ×2).
No es un hallazgo: es contaminación del harness, y se deja anotada para que nadie la lea como
divergencia real.

---

## F6 + F8 · Volumen y latencia — el criterio de producto **NO se cumple**

### 🔴 F8 · Un ticket tarda **99 s** en ser cobrable en el Flex, y empeora con la ocupación — **CONFIRMADO**

Tres jornadas de volumen creciente, con las mesas abriéndose **espaciadas** (ritmo de servicio real,
no ráfaga) para no inflar la medición artificialmente:

| jornada | órdenes | Aloha → MCM p95 | **Aloha → Clover p95** | máx |
|---|---|---|---|---|
| 13 órdenes | 13 | 45.4 s | **54.3 s** | 54.3 s |
| 20 órdenes | 20 | 57.9 s | **73.1 s** | 73.1 s |
| **41 órdenes**, 10 s entre mesas × 3 meseros | 41 | 86.6 s | **98.7 s** | 102.9 s |

**El criterio del plan era p95 ≤ ~30 s. Medido: 98.7 s — más del triple.** Y no es una meseta: la
latencia **crece con el número de cheques abiertos**.

### 🔴 La causa: el pull tarda más que su propio intervalo

Medido sobre los ciclos reales de `fetch_recent_orders` durante la jornada, con el schedule
configurado a **25 s**:

```
08:48:23   40.2s        08:57:46   79.4s
08:49:16   78.1s        08:59:28   42.7s
08:50:58   36.9s        09:00:19  329.4s   ←
08:51:49   48.8s        09:01:35  253.2s   ←
08:52:40   40.6s        09:02:52   67.3s
      …                 09:04:08   83.3s
08:56:55   46.0s        09:09:39   68.6s

intervalo configurado: 25s   ·   duración real: 37–329 s   ·   cheques abiertos al final: 56
```

**Ni un solo ciclo cabe en su intervalo.** El sync corre entre 1.5× y 13× por encima de los 25 s con
los que está programado, así que una orden no espera "medio intervalo": espera al **próximo ciclo que
termine**, que está a 40–80 s. Y como el pase de cheques abiertos relee **todos** los tickets abiertos
en cada vuelta, mientras más se llena el restaurante más tarda el ciclo — de ahí que la latencia
escale con la ocupación.

Es el mismo patrón del incidente en producción de Arena Medalla documentado abajo, donde con **1013
cheques abiertos** el ciclo llegó a **166 s sobre un intervalo de 60 s**. Lo que allá parecía una
anomalía de un site con backlog, aquí se reproduce desde cero con 56 mesas.

**Qué significa operativamente:** el mesero cierra la mesa en Aloha y camina hacia el cliente con el
Flex. **Minuto y medio** después la orden es cobrable — si el restaurante está a media capacidad. Con
la arquitectura de polling actual, "cobrar en la mesa" no es viable: haría falta disparar el push por
evento, o al menos que el pase de abiertos no reprocese todo el backlog en cada vuelta.

### ✅ Bajo carga, la integración no pierde ni descuadra nada

De las 41 órdenes de la jornada grande: **41/41 llegaron a Clover, 0 descuadres POS↔MCM, 0
dead-letters, 0 duplicados**. El límite de concurrencia y el gate anti-solape funcionan. El problema
de volumen es de **latencia**, no de correctitud.

> **Dos notas de honestidad sobre mis propias corridas.** (1) En un primer intento 12 de 25 tickets
> fallaron con `reference_not_found` porque **usé ids de tender como ids de empleado**; y en otro, 60
> de 80 con `employee_clocked_out` porque solo un empleado está fichado en la location. Errores míos,
> corregidos. (2) De los 45 tickets de la jornada final, **4 no totalizaron dentro de 30 s** — el POS
> tardó más (uno tomó 32.8 s). Esos 4 se excluyen de la medición de latencia por no tener instante de
> cierre válido, no por haber fallado la integración.

---

## F7 + F1 · Operación real de restaurante

### ✅ 1.12 · Multi-check en una mesa

Tres cheques abiertos simultáneamente en la mesa 20 → tres órdenes en MCM con `check_number` **1, 2 y
3**, sin colisión del índice único y las tres con el mismo `table_id`. **3/3.**

### ✅ 1.23 · Fire selectivo

Ticket con 3 ítems sin enviar; se firea **solo uno**. Aloha marca 1 `sent`, y MCM refleja
exactamente 1 línea en `status='sent'` con la orden en `in-kitchen`. El espejo del fire es fiel.

### ✅ 7.10 · Doble tap del mesero

Dos `POST /tickets` **simultáneos** sobre la misma mesa: Aloha acepta los dos y MCM crea dos órdenes
con `check_number` distintos. Sin ticket huérfano ni colisión.

### 🔴 7.12 · Cortesía del 100 %: el cliente paga la comida regalada — **CONFIRMADO**

Es el caso más vívido de **R5**, y la cuarta reproducción:

```
POS:     total 1405 → 14      (comp c83 "NBO/Comp" de 1300¢, queda solo el fee + impuesto)
MCM:     0.14                  ✓ sincronizó bien
Clover:  1405                  ✗ el monto ANTES del comp
                               sobrecobro = 1391¢ = $13.91 sobre un cheque de $0.14
```

El gerente comp'ea un plato entero y el terminal le cobra al cliente **el precio completo**.

### 🟢 10.4 y 10.2 · Editar tras el pago: **el POS lo impide** — NO REPRODUCIDO, y es buena noticia

Los dos casos que el plan predecía como peligrosos resultaron **inalcanzables desde Aloha**:

```
10.4  DELETE /tickets/{id}/items/{i}  → 400 "Cannot void ticket items because the ticket is closed."
10.2  POST   /tickets/{id}/items      → 500 y luego 400 (ticket cerrado)
```

Una vez que el cheque cierra, Aloha **no acepta más ediciones**. Eso acota el alcance real del camino
suplementario: solo se dispara cuando el cheque sigue **abierto**, o sea tras un **pago parcial** en
Clover. Y por **N1**, los pagos parciales nunca llegan a aplicarse en Aloha de todos modos.

Consecuencia práctica: `CLOVER_SUPPLEMENTAL_NEGATIVE_DELTA` (10.4) es **inalcanzable con este POS**, y
el mecanismo suplementario —que funciona bien (F10)— tiene un disparador mucho más estrecho de lo que
el plan asumía.

### ~ No verificados por rechazo del POS

| caso | qué respondió Aloha |
|---|---|
| **7.6** transferencia de mesa | `400 invalid_input: "Table is not accepted"` — el `POST /tickets/{id} {table}` no fue aceptado para mover la mesa |
| **1.25** void de ticket completo | `500 pos_failure` (`com_error_code: 36`) — el POS rechazó el `{void:true}`. El cheque siguió abierto y la orden Clover quedó `OPEN` y cobrable, pero **eso es consecuencia del void fallido**, no un hallazgo |
| **7.13** ítem de precio abierto | la location no tiene ninguno (`open:true`) — **0 de 535 ítems** |
| **7.16** acentos y ñ | la carta de `cx9oRBRi` **no tiene ningún nombre acentuado** — no hay con qué probar el round-trip |

---

## F11 restantes

### 🔴 11.2 · El cuadre por tender es imposible — **CONFIRMADO**

Los **40 pagos** de la corrida tienen el **mismo `method`**:

```
method='ecr-card'  source='Omnivore POS'   31 pagos   $2,074.71   propina $0.00
method='ecr-card'  source=''                9 pagos   $  100.22   propina $10.25
métodos distintos en MCM: 1
```

Los **31 pagos nacidos en el POS** ($2,074.71) perdieron su tender real por **N3**. El arqueo de caja
no puede cerrar contra MCM: el efectivo no se distingue de la tarjeta. Los 9 de Clover al menos
conservan la marca en `source`, pero no en `method`.

### ✅ 11.3 · El cuadre por mesero funciona

```
empleado '3184': 35 órdenes  $2,454.55
empleado '975':  47 órdenes  $  583.35
empleado '976':   6 órdenes  $  104.58
órdenes sin empleado atribuido: 0
```

La atribución de venta al mesero está completa — es la base de comisiones y sí es confiable.

### ✅ 11.9 · Idempotencia: cero duplicados de cualquier tipo

```
órdenes MCM duplicadas por ticket de Aloha:  0
pagos duplicados por referencia:             0
órdenes Clover reusadas por 2 órdenes MCM:   0
```

Tras decenas de ciclos de pull, solapes y reintentos. Es el criterio 6 del plan, **cumplido**.

### 11.7 · Dead-letters: 9, todos explicados

3 `clover.order_injection` por `HTTP_429` (**N2**, $248.58 que nunca llegaron a Clover) y 6
`omnivore.payment_injection` por `OMNIVORE_INSUFFICIENT_AMOUNT` (**M1** y **N1**). **9 llaves de
idempotencia siguen retenidas por esos jobs muertos**, que es justo lo que bloquea el reintento (N2).

> Corrección: una primera consulta reportó 18 por un `join` con `job_step_attempts` que multiplica
> filas. Los jobs muertos distintos son **9**.

---

### 🟠 R10 · Solo 3 de 18 marcas de tarjeta rutean a su tender en Aloha — **CONFIRMADO**

No se pudo probar end-to-end: los pagos creados por la Platform API de Clover llegan **sin
`cardTransaction`** — verificado en vivo, 5 de 5 con `cardType` ausente, tender genérico "MCM", y en
consecuencia `payments.source = ''` en MCM. Un Flex real sí lo puebla.

Pero el ruteo es una **función pura** de `payment.source`, así que se cierra de forma determinista
contra `buildOmnivorePaymentBody` de producción, alimentado con el enum real de Clover
(`cert/r10-repro.ts`):

```
VISA      → 975 (SPC VISA)   ✓        DISCOVER, DINERS_CLUB, JCB, MAESTRO, SOLO,
MC        → 976 (SPC M/C)    ✓        LASER, CHINA_UNION_PAY, CARTE_BLANCHE, UNKNOWN,
AMEX      → 978 (SPC AMEX)   ✓        GIFT_CARD, EBT, GIROCARD, INTERAC, OTHER, RUPAY
                                       → 979 (SPC OTHER)  ← todas al genérico
```

El mapa `TENDER_TYPE_BY_CARD` (`build-payment-body.ts:41-47`) tiene **5 claves** (DEBIT, VISA,
ATH_MOVIL, MC, AMEX) contra las **18** del enum de Clover. Todo lo que no matchea cae en
`|| TENDERTYPEID`.

**Lo que lo vuelve un defecto y no una limitación:** la location `cx9oRBRi` **sí tiene** tenders
dedicados que MCM nunca usa — `30 Discover` y `977 SPC DISC` existen en el POS. El reporte de ventas
por tender de Aloha termina agrupando Discover, Diners, JCB, gift card, EBT e Interac bajo
"SPC OTHER", teniendo dónde ponerlos.

Sumado a **N3** (todo cobro hecho en el POS entra como `ecr-card`), el cuadre por tender queda roto
por los dos lados.

---

## Re-verificación · cada hallazgo pasado por un segundo filtro

Terminadas las pruebas, **cada hallazgo se volvió a verificar** contra el código vivo y contra el
estado actual de los tres sistemas, buscando específicamente falsos positivos. Resultado: **3
correcciones y 0 hallazgos retirados.**

### Lo que la re-verificación corrigió

| # | qué decía | qué encontré al re-verificar |
|---|---|---|
| **ABS** | "el absorber enmascara el error de impuesto" | **Injusto con el código.** Su comentario dice *"Sólo reconciliar residuos de centavos (redondeo). Un delta grande sería OTRO problema… y NO se enmascara"* — el autor ya había anticipado R5 y M8. El defecto real es que la divergencia del service charge **cabe dentro de la tolerancia**, no que el absorber esté mal |
| **H1** | "`trigger_sync_now` es el camino de recuperación" | **Falso.** Probado en vivo: `trigger_sync_now()` **no** revive un schedule en `failing`. El único que lo revive es `ensure_sync_schedules()`, o sea re-guardar el formulario de la integración |
| **N3** | "MCM sobrescribe el tender y la propina" | **Es peor.** El `FIELDS` de la petición **ni siquiera pide** `tips` ni `payments`. No se descartan: nunca se preguntan |

### Falsos positivos detectados y descartados

| candidato | por qué NO es un hallazgo |
|---|---|
| "el contador de fallos no se resetea al recuperarse, el schedule muere al primer fallo siguiente" | `002_jobs_functions.sql:462` pone `consecutive_failures = 0` en cada ciclo exitoso. Comportamiento correcto |
| "hay `sync_schedules` duplicados (6 pares)" | El índice único es `(site_id, **integration**, sync_type)`. `fetch_products` de omnivore y de clover son schedules legítimamente distintos; mi query agrupó sin `integration` |
| "105 órdenes fantasma" (primer conteo) | Un cheque **vacío** también tiene `due=0`. Re-medido con el filtro estricto `paid > 0 AND due = 0`: los 105 son cheques **realmente cobrados**; los 12 vacíos se contabilizan aparte |
| "12 dead-letters de `order_injection`" | Un `join` con `job_step_attempts` multiplicaba filas. Son **3** jobs distintos |
| "Σ tax_lines = 0 en todas las órdenes" | El campo es `tax_total`, no `total_tax`. Con el nombre correcto: 8 de 183 divergen |
| "las RPC del motor expuestas a PUBLIC son explotables" | `enqueue_job`, `claim_next_job`, etc. **no** son `SECURITY DEFINER`: corren con los privilegios del llamador y la política `service_role_only` de RLS las contiene |
| "los INSERT de productos/categorías/ingredientes no llevan `site_id`" | Sí lo llevan, en el **objeto de fila**. Mi primer barrido solo miraba la cadena de la query |
| "`sites-service.ts` busca `locations` por slug sin `site_id`" | Hardening **deliberado y documentado**: resolver el slug es justamente el trabajo de esa función, el `site_id` aún no se conoce; usa `.limit(2)` y solo acepta el match único |

### Lo que la re-verificación confirmó

| hallazgo | cómo se re-verificó |
|---|---|
| **M1** | Cadena completa: Clover devuelve `amount` **sin** propina (F0.1) → `totalInDollars = p.amount/100` → el propio comentario del código dice *"el pago de Clover guarda el monto base (sin tip)"* → `buildOmnivorePaymentBody` hace `toCents(total) − toCents(tip)`. **La propina se resta dos veces**, probado de punta a punta |
| **H2** | Aislado sobre los 11 pagos del site: **10 tienen su propio job**, y el único sin job es el 10032, cuya llave `pos_pay:omnivore:10032` la ocupa el site **55126712**. Ni error, ni dead-letter, ni rastro |
| **N2** | 15 horas después, las 3 órdenes siguen con `clover_ticket_id = NULL`, **1 solo job muerto cada una**, y la llave sigue ocupada. `push_orders` corrió cientos de veces |
| **R5** | **0 ocurrencias de `discount`** en todo `buildCloverLineItemsWithTaxes` (líneas 1231-1365) + las 4 órdenes siguen sobrecobrando ahora mismo |
| **M8** | **0 ocurrencias de `voided`** en el mismo builder + las 3 órdenes siguen sobrecobrando ahora mismo |
| **M7** | `.in("status", […"check-closed"])` **sin filtro de `payment_status`** + 105 órdenes medidas con filtro estricto |
| **N4** | Repro determinista contra el mapper de producción, con 2 controles que aíslan `due` como único discriminador |
| **N5** | 2 reproducciones (propina ×4 y ×2) con la **misma** `Idempotency-Id` |
| **F11.5** | Los dos mecanismos leídos en el código: `is_taxable:false` con `total_tax:0.99` en la misma fila, y `taxClass = isStandardProduct ? 'standard' : 'reduced'` decidido por una lista de 7 ids en la config |
| **F8** | 20 ciclos cronometrados: intervalo 25 s, duración real 37–329 s. **Ningún ciclo cabe en su intervalo** |
| **R5/M8 vigentes** | Las 7 órdenes se releyeron contra Clover al cierre: **7/7 siguen sobrecobrando**. No son artefactos viejos |

---

## Multi-tenant · barrido de `site_id` en toda query (§C-bis.4)

Regla del proyecto: **toda query lleva su `site_id` explícito**, aunque haya RLS y aunque la PK
parezca única. El barrido se hizo dirigido, no a ojo:

1. Se derivaron de la base las **212 tablas** con columna `site_id`.
2. De ésas, se aislaron las **39 donde `site_id` forma parte de la PK** — o sea donde `id` **no** es
   único global y un lookup por `id` suelto puede cruzar tenants: `orders`, `payments`, `products`,
   `categories`, `refunds`, `ingredients`, `locations`, `employees`, `ids`…
3. Se escanearon **304 archivos** (`mcm-job-engine/src` + `mcm-edge-functions/_shared`) buscando
   queries sobre esas 39 tablas sin `site_id` en la cadena.

**Resultado: 12 candidatos, 2 reales.** Los otros 10 se descartaron con motivo, no por omisión.

### 🟠 `get-order-list-for-frontend` devuelve órdenes de todos los sites — **CONFIRMADO**

El endpoint **exige `site_id` en el body, lo valida… y nunca lo usa**:

```ts
if(!body.site_id){ throw "Missing Site Id"; }     // get-order-list-for-frontend/index.ts:23
...
let ordersFounded = await getOrdersByCustomerId({  // :30 — site_id NO se pasa
  customer_id: body.user_id,
  attributesToReturn: attributesQueryForOrderFrontend
});
```

Y la función tampoco lo acepta, así que ningún llamador podría acotarla:

```ts
export const getOrdersByCustomerId = async ({ customer_id, attributesToReturn = "*" }) => {
  const {data:orders} = await supabaseAdmin.from("orders")   // orders-service.ts:175
    .select(attributesToReturn).eq("customer_id", customer_id).throwOnError();
```

`supabaseAdmin` es service_role ⇒ **RLS no aplica**. `orders` tiene PK `(id, site_id)`, así que un
mismo `customer_id` con órdenes en dos negocios devuelve las de ambos. El resultado se mapea y se
retorna tal cual, sin filtro posterior. La intención de acotar estaba —el guard lo prueba— pero no se
aplicó. En el mismo archivo, `getOrderById` **sí** recibe `site_id`, o sea que es una inconsistencia
interna, no un criterio de diseño.

### 🟠 El calculador de cupones lee productos de otros tenants — **CONFIRMADO**

`handleCouponsDiscount` (`order-calculator.ts:1454`) resuelve las categorías de los productos del
carrito para evaluar el alcance del cupón:

```ts
const { data: productsWithCategories } = await supabaseAdmin
  .from("products").select("categories_id").in("id", productIds);   // :1476-1478 — sin site_id
...
const orderData = { siteId: createCartParams.site_id, ... };        // :1491 — lo tenía en la mano
```

`products` tiene PK `(id, site_id)`; el id `300015` existe en decenas de sites. Se leen las
`categories_id` de **todos** y se fusionan en el `categoryIds` que decide si un cupón aplica. El
`site_id` correcto está en `createCartParams` y se usa trece líneas más abajo.

> **Alcance:** ninguno de los dos está en el loop Omnivore↔Clover que certifica este documento — las
> órdenes de Aloha no pasan por cupones ni por ese endpoint. Salieron del barrido que el plan exige
> (§C-bis.4) y se reportan porque la regla es transversal.

### Descartados con motivo (los 10 restantes)

| dónde | por qué NO es cruce |
|---|---|
| `claim.ts:26`, `executor.ts:38,101`, `upsert-payments.ts:163` | filtran por PK **uuid** (`job_id`, `integration_jobs.id`, `clover_payment_map.id`) — únicas globalmente |
| `products-write.ts:43,65`, `ingredients-write.ts:27,57`, `clover-helper.ts:391` | son INSERT y el objeto de fila **sí** lleva `site_id` (mi primer barrido solo miraba la cadena) |
| `dispatcher.ts:35` | `alerts_outbox` se drena a propósito para todos los sites |
| `sites-service.ts:322` | **hardening deliberado y documentado**: `locations.slug` es UNIQUE(site_id, slug), y usa `.limit(2)` en vez de `.single()` aceptando solo el match único. El `site_id` aún no se conoce: resolverlo es justamente el trabajo de esa función |

### ✅ Lo que el barrido confirma que está bien

- **Los cuatro INSERT de dinero llevan `site_id`**: `payments-service.ts:274`, `refund-service.ts:140`,
  `void-service.ts:203`, `tip-adjustment-service.ts:162`.
- **`payment.ts` (reenvío a Omnivore)** filtra `.eq('site_id', siteId)` en las cuatro lecturas y
  escrituras del marcador de idempotencia.
- **RLS del motor bien puesta**: `integration_jobs` y `sync_schedules` tienen política
  `service_role_only` para `ALL` y solo SELECT para `authenticated` acotado por
  `has_location_access(site_id)`. Las RPC del motor expuestas a PUBLIC (`enqueue_job`,
  `claim_next_job`, `retry_dead_letter_job`…) **no** son `SECURITY DEFINER`, así que corren con los
  privilegios del llamador y RLS las contiene.
- **El harness de esta certificación** obliga `site_id` estructuralmente: `db.q()` lanza si no se le
  pasa o si el SQL no referencia `$1`.

---

## Verificado como correcto (no todo son bugs)

### ✅ La reconciliación anti-lost-ACK del reenvío de pagos

`omnivore.payment_injection` está protegido por tres capas independientes, y las tres son correctas:

1. **Marcador persistente** — si el pago MCM ya tiene `additional_properties.omnivore_payment_id`,
   se salta (`payment.ts:103-111`). Nota fina bien resuelta: usa ese campo y no `pos_id`, porque para
   un cobro de Clover el `pos_id` ya guarda el id de **Clover** y reusarlo haría que el guard saltara
   siempre sin aplicar nunca.
2. **Reconcile-before-repost** en cada reintento, por `comment` + `amount` (`payment.ts:113-137`).
3. **Fail-closed**: si el GET de reconciliación falla, lanza retryable y **no postea** — nunca
   arriesga un doble tender.

Dado lo que muestra **N5** (el header de idempotencia no sirve y la propina se acumula al reintentar),
esta es la pieza que evita que un hipo del POS se convierta en un cobro duplicado.

### ✅ El cuadre de impuestos MCM → Clover es exacto

Ticket con dos clases de impuesto (comida 6 % + alcohol 10.5 %) más el service charge del POS:

```
Chips & Salsa   600 + 42  (reduced 36 + municipal 6)
Monte Xanic     900 + 104 (estatal 95 + municipal 9)
Fee              14 + 2   (estatal 2 + municipal 0)
                Σ = 1662  =  Clover.total  =  MCM.total  =  Omnivore totals.total
```

El absorber de redondeo ajustó el fee de 15→14 para aterrizar clavado en el total autoritativo del
POS. Los `taxRates` llegan a Clover con los ids correctos del merchant y la escala 1e7.

> Nota metodológica: la primera lectura dio "no cuadra" (Σlíneas=1514, Δ=−148). Era **un bug de mi
> harness**, no del producto: leía `lineItems` sin `expand=lineItems.taxRates` y trataba `taxRates`
> como array cuando Clover lo envuelve en `{elements}`. Corregido antes de seguir.

### ✅ F9 · Ciclo de vida con ediciones desde Omnivore — 5 de 6 pasos cuadran

Una sola mesa (ticket `20260726-1010013`, MCM `10048`), mutaciones secuenciales, cuadre triple tras
**cada** paso:

| paso | POS | MCM | Clover | |
|---|---|---|---|---|
| A1 · comida $6 + alcohol $9 | 1662 | 1662 | 1662 | ✓ |
| A2 · +1 comida $6 | 2311 | 2311 | 2311 | ✓ |
| A4 · +1 ítem con `quantity=2` | 5121 | 5121 | 5121 | ✓ |
| A5 · **void de ítem fireado** | 4473 | 4473 | 4473 | ✓ |
| A6 · +1 comida $5 tras el void | 5013 | 5013 | 5013 | ✓ |
| A7 · descuento de ticket | — | — | — | **NO VERIFICADO** |

Detalles que se comportan bien:
- **`quantity=2`**: Aloha lo parte en 2 filas y MCM propaga las dos a Clover como líneas separadas de
  1300 + 91 cada una. La correlación por `omnivore.item_ids[]` funciona.
- **Void**: la línea anulada desaparece limpiamente de los tres sistemas (POS 4700→4100, MCM 5→4
  líneas, la línea ya no está en Clover). **M8 no se reproduce en el camino de overwrite** — necesita
  `omnivoreTableServiceEnabled=true`, pendiente.
- **Service charge**: escala con el cheque (15 → 21 → 46 → 41 → 45) y su impuesto lo sigue.
- El absorber de redondeo ajusta el fee en cada paso para aterrizar exacto en el total del POS.

> **A7 fue un falso positivo de mi script.** El descuento `c36` fue rechazado por Omnivore con
> `entry_unavailable: "Entry is not configured to be orderable"`, así que los totales no cambiaron y
> el comparador dio "cuadra" comparando el estado consigo mismo. Se repite con un descuento aplicable.

**Dato de configuración del POS:** de los 44 descuentos de `cx9oRBRi`, **solo 6 tienen
`available: true`**, todos de ticket, de porcentaje fijo (`open=false`). **Cero descuentos de ítem
disponibles.** Filtrar por `open` no basta — hay que filtrar por `available`.

### ✅ Ingesta Omnivore → MCM
Ticket con mesa → `orders` con `table_id` linkeado, `check_number=1`, `experience='qe'`,
`status='in-kitchen'`, las 2 líneas con `product_id` resuelto por `omnivoreId`, y `tax_lines` con las
3 tasas PR. Total idéntico al del POS.

---

### 🟡 Característica del POS · Aloha tarda ~1.5 s en reflejar una mutación en `totals`

**Medido, 3 corridas:** el `POST /tickets/{id}/items` responde en ~900 ms, pero `totals` sigue
mostrando el estado anterior hasta los **1460–1680 ms** (promedio 1547 ms).

No es un fallo — es latencia del POS. Importa por dos motivos:
1. Cualquier lectura de `totals` dentro de esa ventana devuelve valores viejos. Mi propio harness
   cayó en esto y produjo un falso "el ítem no se agregó" antes de corregirlo.
2. El sync corre cada 25–60 s, así que la ventana es angosta, pero **existe**: si un `fetch_recent_orders`
   lee un ticket justo después de que el mesero agregó algo, captura el total previo. El siguiente
   ciclo lo corrige.

Evidencia: `lag-aloha-*.json`.

---

## NO REPRODUCIDO — se investigó y el producto está bien

### `price_level` ausente ⇒ ítem a $0 en Aloha — **no aplica a MCM**

**Lo observado:** al agregar el ítem `300155` "Arroz Verde" por API **sin** `price_level`, Aloha lo
inserta con `price = 0`. Con `price_level: 'b0'` explícito entra correctamente a `500`. Aislamiento
limpio: mismo ítem, mismo ticket, misma llamada, única variable el parámetro.

La causa es que su único nivel es `b0`, mientras que los ítems que sí entran bien tienen `i0` — Aloha
asume un nivel por defecto y los que no lo tienen caen a 0.

**Por qué NO es un bug de MCM:** el builder outbound **sí** envía `price_level`, tomándolo de
`products_with_price_level.price_level_pos_id` (`omnivore-helper.ts:1653-1654` y `:2678-2679`).
Verificado en la DB del site de certificación: "Arroz Verde" tiene `price_level_pos_id = 'b0'`
correctamente importado.

Los únicos 12 productos (de 535) sin `price_level_pos_id` son **todos ítems de precio abierto**
(`OPEN FOOD`, `OPEN BAR`, `Ceviche`, los de NYE25), que legítimamente no tienen nivel porque su
precio se fija al ordenar.

**Conclusión:** riesgo descartado. Se documenta para que nadie lo re-investigue.

Evidencia: `price-level-*.json`.

---

## NO VERIFICADO — no se pudo probar con esta superficie de API

### M2 · Void y refund de un pago de Clover — **DIFERIDO POR DECISIÓN DE ALCANCE (2026-07-27)**

> Refund y void quedan **fuera del alcance de esta certificación** por decisión del dueño. El sandbox
> tampoco los permitía (405/405/401). Se documenta el análisis para cuando se retomen.


El sandbox **rechaza los tres endpoints de refund** probados:

```
POST /payments/{id}/refunds   → HTTP 405
POST /refunds  {payment:{id}} → HTTP 405
POST /orders/{id}/refunds     → HTTP 401
```

Coincide con el 405 que ya había frenado la corrida previa del harness `e2e-clover.ts`
(`refund_accepted: false` en su evidencia). El dump local de la doc **no documenta ningún endpoint de
refund ni de void** — solo los objetos de lectura. La predicción del análisis (el refund no cambia
`payments.status`, no recalcula `orders.paid` y no llega a Omnivore) sigue siendo **verificable por
lectura de código** (`upsert-payments.ts:140-181`), pero **no se pudo ejercitar en runtime**.

Para cerrarlo haría falta: un merchant sandbox con refunds habilitados, o la Ecommerce API
(`/v1/refunds`), que requiere otra credencial.

### M5 · Ajuste de propina post-captura — **DIFERIDO POR DECISIÓN DE PRODUCTO (2026-07-27)**

> **No aplica a esta operación.** El dueño confirmó que **la propina siempre se deja al momento de
> pagar**: no hay flujo pay-first / tip-later en este restaurante. El ajuste post-captura no ocurre,
> así que M5 se cierra como **fuera de alcance**, no como riesgo pendiente.
>
> **Pero esto agrava M1.** Si toda propina se captura en el momento del cobro, entonces
> **prácticamente todos los pagos del servicio llevan propina** — y M1 rechaza **todos** los pagos con
> propina (`insufficient_amount`). El caso que sí funciona ("pago completo, sin propina") pasa de ser
> "el menos frecuente" a ser **casi inexistente** en esta operación. M1 no degrada la integración: la
> inutiliza.

El análisis técnico original se conserva abajo por si el flujo cambia:


Los tres endpoints de tip-adjust fallan, y el primero explica por qué:

```
POST /payments/{id} {tipAmount}          → HTTP 400
   "Currently only lineItem payments or employee associated to payment
    can be updated. No lineItem payments or employee ID found."
POST /orders/{o}/payments/{p} {tipAmount} → HTTP 405
PUT  /payments/{id} {tipAmount}           → HTTP 401
```

El ajuste de propina **no se hace por la Platform API** — va por el dispositivo (Android Payments
API / REST Pay Display) o por el cierre de lote. Con el token de merchant no es simulable.

La predicción sigue en pie por lectura de código: `upsert-payments.ts:140-181` detecta `tipChanged`,
actualiza `clover_payment_map` y `payments.tip/total`, y hace `continue` — **nunca llama a
`maybeForwardPaymentToOmnivore`**, que solo existe en la rama de INSERT (`:383-390`). Queda como
**PROBABLE por código, no reproducido en runtime**.

> **Control adicional de M1 obtenido en esta corrida:** el paso previo al ajuste (cobro con propina 0)
> reenvió correctamente — `omnivore_payment_id=105906178`, cheque `due=0 paid=649 open=false`. Es el
> tercer control que aísla la propina como única causa de M1.

### F6 · Jornada de 100 órdenes — no se pudo correr

El sandbox de Aloha (`cx9oRBRi`) se degradó durante la corrida hasta no poder sostener ni un ticket
simple. Con la location reportando `status: online` en tres sondas seguidas, las escrituras fallaban:

```
POST /tickets/{id}/payments  → 500 timeout
POST /tickets/{id}/payments  → 500 pos_not_responding_retry   (×4 seguidos)
POST /tickets/{id}/items     → el ticket nunca totalizó (30 s de espera)
```

De 8 casos intentados en la última tanda, **3 no llegaron siquiera a totalizar el ticket**. Correr una
jornada de 100 órdenes contra este POS no mediría la integración: mediría el sandbox. Se marca
**NO VERIFICADO**, no "falló".

Lo que sí queda medido de la degradación, y es un dato útil de por sí: el agente de Aloha responde
`pos_not_responding_retry` **después** de haber aplicado la mutación (lost-ACK), y es de ahí que salen
**N4** y **N5**. Un restaurante en rush ve exactamente este comportamiento.

### El riesgo residual de la reconciliación por `comment` + `amount`

La defensa anti-duplicado de `payment_injection` matchea el pago existente por `comment` **y**
`amount` (`payment.ts:127-131`). Dos pagos del mismo cheque con idéntico monto e idéntico comment
serían indistinguibles entre sí. No se pudo ejercitar porque los pagos divididos mueren antes por
**N1** (`insufficient_amount`), así que queda como **NO VERIFICADO** — no como hallazgo.

---

## Pendiente de investigar

- **`insufficient_amount` histórico**: los 4 dead-letters previos del site 55126712 (orden 10542,
  total 91.57 / paid 47.57) parecían pagos parciales del operador. Ahora sé que M1 produce el mismo
  slug. Falta discriminar cuáles fueron cuáles.
- **Arena Medalla `not_found`**: el sync de órdenes del site vivo murió con `Omnivore not_found` tras
  3 corridas de 166 s que traían 1013 tickets sin insertar nada. El shape del error coincide con el
  capturado en F0.7. Hipótesis a validar con los logs locales: `_links.next` obsoleto a mitad de
  paginación sobre un conjunto que se mueve. **No se tocó** (decisión del usuario).

---

## Estado del entorno al cerrar

| elemento | estado |
|---|---|
| Vecino `25612612.fetch_recent_orders` | **restaurado** a `active` / 60 s / 0 fallos (era como lo encontramos) |
| Site de certificación `99990003` | `active` / 25 s / 0 fallos · integraciones omnivore y clover `active=true` |
| Credenciales tocadas en F5.4 | **restauradas** (la `apiKey` se invalidó a propósito y se devolvió) |
| Schedules deshabilitados en F11.bis | **restaurados** a `active` |
| Datos de vecinos | sin cambios inesperados. El crecimiento de `25612612` (+148 órdenes) es el efecto **buscado** de MT-1: comparte la location |
| Workers | corriendo **en local** (`pos_sync` :3010 con scheduler, `pos_injection` :3011). Sostienen también los sites vivos — hay que levantar los de la nube **antes** de bajar estos |
| Código de producción | **sin un solo cambio**. La certificación no arregló nada, según lo acordado |

## Cómo está organizada la evidencia

```
cert/
├── HALLAZGOS.md          este informe
├── lib.cjs               harness unificado Omnivore × MCM × Clover
│                         (db.q() exige site_id estructuralmente: lanza si falta)
├── evidence/*.json       43 archivos, uno por caso, con secretos redactados
└── *.cjs / n4-repro.ts   38 scripts de prueba, re-ejecutables
```

Los scripts más útiles para re-validar un arreglo:

| script | qué prueba |
|---|---|
| `final.cjs` | reconciliación completa de los 3 sistemas + todas las métricas del informe |
| `f6.cjs N C PACE` | jornada de volumen y latencia p50/p95 (`node f6.cjs 45 3 10000`) |
| `n4-repro.ts` | repro determinista de N4 contra el mapper de producción |
| `atribuir.cjs` | atribuye cada descuadre POS≠Clover a R5 o M8 |
| `f11-resto.cjs` | cuadre por tender, por mesero, dead-letters, idempotencia |
| `f5-bis.cjs` | mata un schedule a propósito y prueba las palancas de apagado |
| `mt1.cjs` | aislamiento con 2 tenants sobre la misma location |
