import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existingUnitKeys, isCardMethod, modeloSirve, testCardInstrument, unitKey } from '../../src/handlers/subs/apply-payment-rules';

// ── Reglas puras ────────────────────────────────────────────────────────────────────────────────
describe('apply-payment · reglas', () => {
  it('R2: llaves por (línea, unidad); filas viejas sin línea → legacy', () => {
    expect(existingUnitKeys([{ line_item_id: 'lineitem-0', unit_index: 0 }, { line_item_id: 'lineitem-0', unit_index: 3 }]))
      .toEqual({ legacy: false, keys: new Set(['lineitem-0:0', 'lineitem-0:3']) });
    expect(existingUnitKeys([{ line_item_id: null, unit_index: 0 }]).legacy).toBe(true);
    expect(existingUnitKeys([]).keys.size).toBe(0);
    expect(unitKey('lineitem-2', 7)).toBe('lineitem-2:7');
  });
  it('test_card cuenta como tarjeta (cobro automático posible)', () => {
    expect(isCardMethod('test_card')).toBe(true);
    expect(isCardMethod('stripe')).toBe(true);
    expect(isCardMethod('cod')).toBe(false);
    expect(isCardMethod(null)).toBe(false);
  });
  it('R1: instrumento de Test Card con provider stripe y pm_sandbox; basura → null', () => {
    expect(testCardInstrument({ provider: 'test_card', provider_customer_id: 'cus_sandbox_tc10043', provider_pm_id: 'pm_sandbox_decline__tc10043', brand: 'visa', last4: '0341', exp_month: 12, exp_year: 2030 }))
      .toEqual({ provider: 'stripe', connected_account_id: 'acct_sandbox_test_card', provider_customer_id: 'cus_sandbox_tc10043', provider_pm_id: 'pm_sandbox_decline__tc10043', brand: 'visa', last4: '0341', exp_month: 12, exp_year: 2030 });
    expect(testCardInstrument({ provider_pm_id: 'pm_1Nreal' })).toBeNull();
    expect(testCardInstrument(undefined)).toBeNull();
  });
  it('D-083: un plan sólo sirve para sus modelos; sin modelos (plan o equipo) se acepta como antes', () => {
    expect(modeloSirve([10002], 10002)).toBe(true);
    expect(modeloSirve([10002], 10003)).toBe(false);
    expect(modeloSirve([], 10003)).toBe(true);
    expect(modeloSirve(null, 10003)).toBe(true);
    expect(modeloSirve([10002], null)).toBe(true);
  });
});

// ── Handler con el repositorio simulado ─────────────────────────────────────────────────────────
const repo = vi.hoisted(() => ({
  loadPayment: vi.fn(), loadOrders: vi.fn(), loadSettings: vi.fn(), loadPublishedTerms: vi.fn(),
  existingUnitsForOrder: vi.fn(), customerIdByAccountEmail: vi.fn(), demoteOtherDefaults: vi.fn(),
  upsertInstrument: vi.fn(), attachInstrumentToOrder: vi.fn(), insertSubscription: vi.fn(), insertFirstPeriod: vi.fn(),
  logEvents: vi.fn(), enqueueSubsJob: vi.fn(), descuentoRecurrenteDeLaOrden: vi.fn(), equipoActivable: vi.fn(), activarEquipo: vi.fn(),
  modelosDePlanes: vi.fn(), avisarEquipoActivado: vi.fn(), cerrarOrdenSoloPlanes: vi.fn(), encolarAltaServicio: vi.fn(),
}));
vi.mock('../../src/handlers/subs/repo', () => repo);
vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { getHandler } from '../../src/handlers/registry';
import '../../src/handlers/subs/apply-payment';

const SITE = 70100000;
const run = () => getHandler('subs', 'apply_payment')!({ jobPayload: { payment_id: 500, site_id: SITE } } as never) as Promise<any>;
const term = { id: 't-m', code: 'monthly', plan_id: 'plan-ddl', product_id: 10014, variation_id: 'monthly', interval_unit: 'month', interval_count: 1 };
const order = (qty: number, email = 'qa+a@mcmtest.app') => ({
  id: 900, site_id: SITE, crm_customer_id: 'cus-phone', customer: { email, phone_e164: '+17875550143' }, additional_properties: {},
  line_items: [{ id: 'lineitem-0', product_id: 10001, quantity: qty, price: 74.95 }, { id: 'lineitem-1', product_id: 10014, variation_id: 'monthly', quantity: qty, price: 20.95 }],
});

describe('subs.apply_payment', () => {
  let seq = 0;
  beforeEach(() => {
    for (const f of Object.values(repo)) f.mockReset();
    seq = 0;
    repo.loadSettings.mockResolvedValue({ is_enabled: true, auto_collection_max_interval_months: 1 });
    repo.loadPublishedTerms.mockResolvedValue([term]);
    repo.descuentoRecurrenteDeLaOrden.mockResolvedValue(null);
    repo.equipoActivable.mockResolvedValue(null);
    repo.insertSubscription.mockImplementation(async () => `sub-${++seq}`);
    repo.customerIdByAccountEmail.mockResolvedValue(null);
    repo.upsertInstrument.mockResolvedValue('inst-1');
    repo.modelosDePlanes.mockResolvedValue(new Map([['plan-ddl', [10001]]]));
  });

  it('R2: flota de 20 con 10 ya creadas → crea SÓLO las 10 que faltan (unidades 10..19)', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([order(20)]);
    repo.existingUnitsForOrder.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ line_item_id: 'lineitem-1', unit_index: i })));
    const r = await run();
    expect(r.created).toBe(10);
    const unidades = repo.insertSubscription.mock.calls.map(([row]) => (row as any).metadata.unit_index);
    expect(unidades).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(repo.insertSubscription.mock.calls.every(([row]) => (row as any).metadata.line_item_id === 'lineitem-1')).toBe(true);
  });

  it('reintento con todo creado → no duplica (already_applied)', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'stripe', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([order(2)]);
    repo.existingUnitsForOrder.mockResolvedValue([{ line_item_id: 'lineitem-1', unit_index: 0 }, { line_item_id: 'lineitem-1', unit_index: 1 }]);
    expect(await run()).toEqual({ skipped: 'already_applied', existentes: 2 });
    expect(repo.insertSubscription).not.toHaveBeenCalled();
  });

  it('filas viejas sin línea → conducta anterior (orden aplicada, nada nuevo)', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'stripe', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([order(2)]);
    repo.existingUnitsForOrder.mockResolvedValue([{ line_item_id: null, unit_index: 0 }]);
    expect((await run()).skipped).toBe('already_applied');
    expect(repo.insertSubscription).not.toHaveBeenCalled();
  });

  it('R8: el email con cuenta manda sobre la ficha del teléfono', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([order(1, 'qa+cuenta@mcmtest.app')]);
    repo.existingUnitsForOrder.mockResolvedValue([]);
    repo.customerIdByAccountEmail.mockResolvedValue('cus-email');
    await run();
    expect(repo.customerIdByAccountEmail).toHaveBeenCalledWith(SITE, 'qa+cuenta@mcmtest.app');
    expect((repo.insertSubscription.mock.calls[0][0] as any).customer_id).toBe('cus-email');
  });

  it('R8: sin cuenta para ese email → la ficha CRM del teléfono (como siempre)', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([order(1)]);
    repo.existingUnitsForOrder.mockResolvedValue([]);
    await run();
    expect((repo.insertSubscription.mock.calls[0][0] as any).customer_id).toBe('cus-phone');
    expect((repo.insertSubscription.mock.calls[0][0] as any).collection).toBe('auto');
  });

  it('R1: Test Card guarda la tarjeta (provider stripe, predeterminada) y la liga — también en un reintento sin nada nuevo', async () => {
    const inst = { provider_customer_id: 'cus_sandbox_tc500', provider_pm_id: 'pm_sandbox_ok__tc500', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: { test_card_instrument: inst } });
    repo.loadOrders.mockResolvedValue([order(1)]);
    repo.existingUnitsForOrder.mockResolvedValue([{ line_item_id: 'lineitem-1', unit_index: 0 }]);
    const r = await run();
    expect(r.skipped).toBe('already_applied');
    expect(repo.demoteOtherDefaults).toHaveBeenCalledWith(SITE, 'cus-phone', 'pm_sandbox_ok__tc500');
    expect(repo.upsertInstrument).toHaveBeenCalledWith(expect.objectContaining({ site_id: SITE, customer_id: 'cus-phone', provider: 'stripe', provider_pm_id: 'pm_sandbox_ok__tc500', is_default: true, status: 'active' }));
    expect(repo.attachInstrumentToOrder).toHaveBeenCalledWith(SITE, 900, 'inst-1');
    expect(repo.enqueueSubsJob).not.toHaveBeenCalled();
  });

  it('pago sin líneas de plan → no guarda tarjeta ni crea nada', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: { test_card_instrument: { provider_pm_id: 'pm_sandbox_ok__tc500' } } });
    repo.loadOrders.mockResolvedValue([{ ...order(1), line_items: [{ id: 'lineitem-0', product_id: 10006, quantity: 1, price: 45 }] }]);
    repo.existingUnitsForOrder.mockResolvedValue([]);
    expect(await run()).toEqual({ skipped: 'no_subscription_lines' });
    expect(repo.upsertInstrument).not.toHaveBeenCalled();
  });

  // ── Flujo c (comprar el plan para un equipo que ya tiene) ──
  const ordenFlujoC = () => ({ ...order(1), additional_properties: { subs: { asset_id: 'asset-1' } } });

  it('D-083: equipo del MISMO modelo → el plan nace activo y atado al equipo', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([ordenFlujoC()]);
    repo.existingUnitsForOrder.mockResolvedValue([]);
    repo.equipoActivable.mockResolvedValue({ id: 'asset-1', product_id: 10001 });
    await run();
    const fila = repo.insertSubscription.mock.calls[0][0] as any;
    expect(fila.status).toBe('active');
    expect(fila.asset_id).toBe('asset-1');
    expect(repo.modelosDePlanes).toHaveBeenCalledWith(SITE, ['plan-ddl']);
    expect(repo.activarEquipo).toHaveBeenCalledWith(SITE, 'asset-1');
    // D-089: el alta en el servicio se encola SOLA (con el correo), sin pedirle contraseña al cliente.
    expect(repo.encolarAltaServicio).toHaveBeenCalledWith(SITE, 'asset-1', expect.any(String));
  });

  it('D-083: equipo de OTRO modelo → el plan NO se le pega (nace pendiente) y queda rastro wrong_model', async () => {
    repo.loadPayment.mockResolvedValue({ id: 500, status: 'completed', method: 'test_card', orders_ids: [900], additional_properties: {} });
    repo.loadOrders.mockResolvedValue([ordenFlujoC()]);
    repo.existingUnitsForOrder.mockResolvedValue([]);
    repo.equipoActivable.mockResolvedValue({ id: 'asset-1', product_id: 10003 });
    await run();
    const fila = repo.insertSubscription.mock.calls[0][0] as any;
    expect(fila.status).toBe('pending_activation');
    expect(fila.asset_id).toBeUndefined();
    expect(repo.activarEquipo).not.toHaveBeenCalled();
    expect(repo.encolarAltaServicio).not.toHaveBeenCalled();
    const eventos = repo.logEvents.mock.calls.flatMap(([rows]) => rows as any[]);
    expect(eventos).toContainEqual(expect.objectContaining({ kind: 'flow_c_not_attached', payload: expect.objectContaining({ reason: 'wrong_model', asset_id: 'asset-1', asset_product_id: 10003, plan_models: [10001] }) }));
  });
});
