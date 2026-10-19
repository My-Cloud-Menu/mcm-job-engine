import { Job } from '../../../core/types';
import { getSiteIntegrationConfig, ConnectionScope, IntegrationConfig } from '../../../lib/credentials';

/**
 * Conexión sellada en el job al encolarlo (Misión Omnivore Multisucursal, M5/M6). Solo la llevan las órdenes de
 * negocios con sucursales conectadas; un payload sin sello resuelve exactamente como antes.
 */
export function sealedScope(jobPayload: Record<string, unknown>): ConnectionScope | undefined {
  const integrationId = jobPayload['integration_id'];
  return typeof integrationId === 'string' && integrationId ? { integrationId } : undefined;
}

/**
 * Config de Omnivore para un paso de inyección. Con sello: la fila sellada (aunque se haya desactivado después, para
 * terminar el ticket ya abierto) y SIEMPRE el `omnivore_id` sellado, para que todos los pasos y reintentos vayan al
 * mismo Aloha. Sin sello: la consulta de siempre.
 */
export async function resolveInjectionConfig(job: Job, jobPayload: Record<string, unknown>): Promise<IntegrationConfig> {
  const conn = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos', sealedScope(jobPayload));
  const sealedOmnivoreId = jobPayload['omnivore_id'];
  if (typeof sealedOmnivoreId === 'string' && sealedOmnivoreId) {
    return { ...conn, config: { ...conn.config, omnivoreId: sealedOmnivoreId } };
  }
  return conn;
}
