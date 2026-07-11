// Sanitiza la respuesta de GET /1.0/locations/:id/ de Omnivore (Aloha) a la fila pos_health.
// SEGURIDAD: NUNCA incluye apiKey ni config — solo el snapshot de salud observable.
// ESPEJO: idéntico a mcm-edge-functions/supabase/functions/_shared/helpers/pos-health.ts
//         (cualquier cambio de shape va en ambos a la vez).
export interface SanitizedPosHealth {
  location_id: string | null;
  pos_status: string | null;
  pos_type: string | null;
  agent_version: string | null;
  overall_healthy: boolean | null;
  agent_healthy: boolean | null;
  agent_cpu: number | null;
  agent_memory: number | null;
  agent_processes: number | null;
  system_healthy: boolean | null;
  system_cpu: number | null;
  system_memory: number | null;
  tickets_status: string | null;
  tickets_response_time: number | null;
  ordering_healthy: boolean | null;
}

const n = (v: unknown): number | null => (typeof v === "number" && !Number.isNaN(v) ? v : null);
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function sanitizeOmnivoreHealth(loc: any): SanitizedPosHealth {
  const h = loc?.health ?? {};
  return {
    location_id: loc?.id ?? null,
    pos_status: loc?.status ?? null,
    pos_type: loc?.pos_type ?? null,
    agent_version: loc?.agent_version ?? null,
    overall_healthy: b(h?.healthy),
    agent_healthy: b(h?.agent?.healthy),
    agent_cpu: n(h?.agent?.average_cpu),
    agent_memory: n(h?.agent?.average_memory),
    agent_processes: n(h?.agent?.processes),
    system_healthy: b(h?.system?.healthy),
    system_cpu: n(h?.system?.average_cpu),
    system_memory: n(h?.system?.average_memory),
    tickets_status: h?.tickets?.status ?? null,
    tickets_response_time: n(h?.tickets?.response_time),
    ordering_healthy: b(h?.pos?.ordering?.healthy),
  };
}
