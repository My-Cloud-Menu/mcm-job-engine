import { supabase } from '../../lib/supabase';

// Helpers de print_jobs para los handlers de la cola 'printing'. Multi-tenant: TODA query filtra site_id
// (service_role bypassa RLS). El engine es el cerebro de retry; la fuente de verdad del ciclo es print_jobs.

export interface PrintJobRow {
  id: string;
  site_id: number;
  status: string;
  payload: Record<string, any>;
  printer_id: string;
  transport: string;
  attempts: number;
}

export async function loadPrintJob(printJobId: string, siteId: number): Promise<PrintJobRow | null> {
  const { data } = await supabase
    .from('print_jobs')
    .select('id, site_id, status, payload, printer_id, transport, attempts')
    .eq('id', printJobId)
    .eq('site_id', siteId)
    .maybeSingle();
  return (data as PrintJobRow) ?? null;
}

export async function loadPrinter(printerId: string, siteId: number): Promise<Record<string, any>> {
  const { data } = await supabase
    .from('printers')
    .select('config, connection_id, qz_printer_name, devid')
    .eq('id', printerId)
    .eq('site_id', siteId)
    .maybeSingle();
  return data ?? {};
}

export async function logEvent(
  printJobId: string, siteId: number, eventType: string, toStatus: string | null,
  source: string, detail: Record<string, unknown> = {},
): Promise<void> {
  await supabase.from('print_job_events').insert({
    print_job_id: printJobId, site_id: siteId, event_type: eventType, to_status: toStatus, source, detail,
  });
}

export async function markDispatched(printJobId: string, siteId: number): Promise<void> {
  await supabase.from('print_jobs')
    .update({ status: 'dispatched', dispatched_at: new Date().toISOString() })
    .eq('id', printJobId).eq('site_id', siteId);
  await logEvent(printJobId, siteId, 'dispatched', 'dispatched', 'engine');
}

export async function markPrinted(printJobId: string, siteId: number): Promise<void> {
  await supabase.from('print_jobs')
    .update({ status: 'printed', printed_at: new Date().toISOString(), error_code: null })
    .eq('id', printJobId).eq('site_id', siteId);
  await logEvent(printJobId, siteId, 'printed', 'printed', 'engine');
}

/** retryable → deja 'retry' (el engine reintenta con backoff); permanente → 'failed'. */
export async function markFailed(printJobId: string, siteId: number, code: string, retryable: boolean): Promise<void> {
  const status = retryable ? 'retry' : 'failed';
  await supabase.from('print_jobs')
    .update({ status, error_code: code, failed_at: new Date().toISOString() })
    .eq('id', printJobId).eq('site_id', siteId);
  await logEvent(printJobId, siteId, 'failed', status, 'engine', { code });
}
