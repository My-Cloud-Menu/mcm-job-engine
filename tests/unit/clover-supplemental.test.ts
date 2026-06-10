import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  manifest: null as any, // additional_properties.clover_supplemental
  apUpdates: [] as any[],
  enqueued: [] as any[],
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child: () => ({ info: vi.fn() }) },
}));
vi.mock('../../src/enqueue/helpers', () => ({
  enqueueCloverSupplementalInjection: vi.fn(async (p: any) => {
    h.enqueued.push(p);
    return 'supp-job-1';
  }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { additional_properties: h.manifest ? { clover_supplemental: h.manifest } : {} },
            }),
          }),
        }),
      }),
      update: (patch: any) => {
        h.apUpdates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  },
}));
vi.mock('../../src/handlers/clover/client', () => ({
  createCloverClient: () => ({ get: h.get, post: h.post, delete: h.del }),
  CloverConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({ config: { apiKey: 'k' }, integrationId: 'i' })),
}));

import {
  lineKey,
  multisetFromLines,
  computeDelta,
  mergedBilledKeys,
  deltaSignature,
  buildSupplementalExternalRef,
  handlePaidPrimaryDelta,
} from '../../src/handlers/clover/inject/supplemental';
import { enqueueCloverSupplementalInjection } from '../../src/enqueue/helpers';
import '../../src/handlers/clover/inject/create-supplemental-order';
import { getHandler } from '../../src/handlers/registry';

const burger = { name: 'Burger', note: '', price: 1000, taxRates: [{ taxAmount: 100 }] };
const fries = { name: 'Fries', note: '', price: 500, taxRates: [{ taxAmount: 50 }] };

beforeEach(() => {
  h.manifest = null;
  h.apUpdates.length = 0;
  h.enqueued.length = 0;
  h.get.mockReset();
  h.post.mockReset();
  h.del.mockReset();
  (enqueueCloverSupplementalInjection as any).mockClear();
});

describe('supplemental delta (pure)', () => {
  it('lineKey ignores price (absorber-independent), uses name+note', () => {
    expect(lineKey({ name: 'Burger', note: 'no onion', price: 999 })).toBe('Burger||no onion');
    expect(lineKey({ name: 'Burger', note: 'no onion', price: 1 })).toBe('Burger||no onion');
  });

  it('append-only delta = the new items, with correct total', () => {
    const billed = multisetFromLines([burger]);
    const d = computeDelta([burger, fries], billed);
    expect(d.hasRemoval).toBe(false);
    expect(d.deltaLines).toEqual([fries]);
    expect(d.totalCents).toBe(550); // 500 + 50 tax
  });

  it('no delta when current == billed', () => {
    const d = computeDelta([burger, fries], multisetFromLines([burger, fries]));
    expect(d.deltaLines).toEqual([]);
    expect(d.hasRemoval).toBe(false);
  });

  it('detects removals (negative delta)', () => {
    const d = computeDelta([burger], multisetFromLines([burger, fries]));
    expect(d.hasRemoval).toBe(true);
    expect(d.deltaLines).toEqual([]);
  });

  it('quantity-aware: 2 billed, 3 now → delta 1', () => {
    const d = computeDelta([burger, burger, burger], multisetFromLines([burger, burger]));
    expect(d.deltaLines.length).toBe(1);
  });

  it('mergedBilledKeys sums primary + supplements', () => {
    const m = {
      primary: { billed_keys: { 'Burger||': 1 } },
      supplements: [{ delta_keys: { 'Fries||': 2 } } as any],
    };
    expect(mergedBilledKeys(m)).toEqual({ 'Burger||': 1, 'Fries||': 2 });
  });

  it('externalRef is ≤12 chars and deterministic', () => {
    const sig = deltaSignature({ 'Fries||': 1 });
    const r = buildSupplementalExternalRef(48372619, 10011, sig);
    expect(r.length).toBeLessThanOrEqual(12);
    expect(r).toBe(buildSupplementalExternalRef(48372619, 10011, sig));
  });
});

describe('handlePaidPrimaryDelta', () => {
  it('new items on a paid primary → enqueues a supplemental (manifest seeded from Clover)', async () => {
    // Legacy order (no manifest): seed billed from the current Clover line items.
    const out = await handlePaidPrimaryDelta({
      siteId: 25,
      orderId: 5,
      cloverOrderId: 'CLOVER-1',
      frozenLineItems: [burger, fries],
      desiredHash: 'H2',
      currentCloverLineItems: [{ name: 'Burger', note: '' }],
    });
    expect(out.supplemental_enqueued).toBe('supp-job-1');
    expect(out.delta_items).toBe(1);
    expect(h.enqueued[0]).toMatchObject({ siteId: 25, orderId: 5, totalCents: 550, lineItems: [fries] });
    // persisted the manifest (supplement entry) AND the primary hash
    expect(h.apUpdates.some((u) => u.additional_properties?.clover_supplemental)).toBe(true);
    expect(h.apUpdates.some((u) => u.clover_line_items_hash === 'H2')).toBe(true);
  });

  it('no new items → no_delta_paid, no enqueue', async () => {
    const out = await handlePaidPrimaryDelta({
      siteId: 25,
      orderId: 5,
      cloverOrderId: 'CLOVER-1',
      frozenLineItems: [burger],
      desiredHash: 'H2',
      currentCloverLineItems: [{ name: 'Burger', note: '' }],
    });
    expect(out).toMatchObject({ skipped: 'no_delta_paid' });
    expect(enqueueCloverSupplementalInjection).not.toHaveBeenCalled();
  });

  it('removed item → needs_review negative_delta, no enqueue', async () => {
    const out = await handlePaidPrimaryDelta({
      siteId: 25,
      orderId: 5,
      cloverOrderId: 'CLOVER-1',
      frozenLineItems: [burger],
      desiredHash: 'H2',
      currentCloverLineItems: [{ name: 'Burger', note: '' }, { name: 'Fries', note: '' }],
    });
    expect(out).toMatchObject({ needs_review: 'negative_delta' });
    expect(enqueueCloverSupplementalInjection).not.toHaveBeenCalled();
  });
});

describe('create_supplemental_order handler', () => {
  const handler = getHandler('clover', 'create_supplemental_order')!;
  const job = { id: 'j', site_id: 25, correlation_id: 'c' } as any;
  const step = { idempotency_key: 'k', attempt_count: 0, max_attempts: 3 } as any;
  const orderBody = { title: "MCM #5 (add'l)", state: 'open', externalReferenceId: 'ms123' };

  it('adopts by manifest delta_signature (no POST)', async () => {
    h.manifest = { supplements: [{ delta_signature: 'SIG1', clover_order_id: 'SUPP-EXIST' }] };
    const out = await handler({
      stepInput: {},
      jobPayload: { order_id: 5, order_body: orderBody, external_reference_id: 'ms123', delta_signature: 'SIG1' },
      context: {},
      job,
      step,
    });
    expect(out).toMatchObject({ clover_order_id: 'SUPP-EXIST', adopted: true });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('creates the supplemental order and persists its id into the manifest', async () => {
    h.manifest = { supplements: [{ delta_signature: 'SIG1', clover_order_id: null }] };
    h.get.mockResolvedValue({ data: { elements: [] } }); // no externalRef match
    h.post.mockResolvedValue({ data: { id: 'SUPP-NEW' } });
    const out = await handler({
      stepInput: {},
      jobPayload: { order_id: 5, order_body: orderBody, external_reference_id: 'ms123', delta_signature: 'SIG1' },
      context: {},
      job,
      step,
    });
    expect(out).toMatchObject({ clover_order_id: 'SUPP-NEW' });
    expect(h.post).toHaveBeenCalledWith('/orders', orderBody);
    expect(h.apUpdates.some((u) => JSON.stringify(u).includes('SUPP-NEW'))).toBe(true);
  });
});
