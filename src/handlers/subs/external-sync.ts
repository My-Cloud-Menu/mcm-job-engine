import { z } from 'zod';
import { registerHandler } from '../registry';
import { HandlerError } from '../../core/types';
import { supabase } from '../../lib/supabase';
import { callSubsEdge } from './call-edge';

// subs.external_sync — el conector del servicio externo (D-055, misión iOTEK). Lo hace la edge `subs-external-sync`; aquí sólo se
// llama y se limpia.
//
// La contraseña de la app viaja SELLADA en el payload (`sealed`, AES-GCM con una clave que este motor NO tiene). En cuanto el
// resultado es FIRME —hecho, omitido o fallo que no se reintenta— el sello se BORRA del payload del job: ya no hace falta y no se
// deja guardado. Con un fallo temporal (5xx) se conserva para el reintento. La respuesta de la edge nunca lo lleva.
const Input = z.object({
  site_id: z.number(),
  asset_id: z.string(),
  action: z.enum(['activate', 'suspend', 'reactivate', 'status']),
  user_name: z.string().optional(),
  sealed: z.string().optional(),
});

async function borrarSello(job: { id: string; site_id: number; payload: Record<string, unknown> }): Promise<void> {
  const { sealed: _s, ...resto } = job.payload ?? {};
  const { error } = await supabase.from('integration_jobs').update({ payload: resto }).eq('id', job.id).eq('site_id', job.site_id);
  if (error) console.error('[subs.external_sync] no se pudo borrar el sello del payload:', error.message);
}

registerHandler('subs', 'external_sync', async ({ jobPayload, job, step }) => {
  const p = Input.parse(jobPayload);
  try {
    // `attempt_count` es lo YA intentado: el intento en curso es +1 (igual que el ejecutor). Con `max_attempts` la edge sabe cuándo
    // es el último y convierte un fallo temporal en firme (no queda «conectando» para siempre, revisión F5 #6/#9).
    const r = await callSubsEdge('subs-external-sync', { ...p, attempt: (step?.attempt_count ?? 0) + 1, max_attempts: step?.max_attempts ?? null }, 60_000);
    if (p.sealed) await borrarSello(job);
    return r;
  } catch (e) {
    if (p.sealed && e instanceof HandlerError && !e.retryable) await borrarSello(job);
    throw e;
  }
});
