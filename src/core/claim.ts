import { supabase } from '../lib/supabase';
import { config } from '../config';
import { Job, JobStep } from './types';

/** Atomically claims the next available job for this worker. Returns null when the queue is empty. */
export async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await supabase.rpc('claim_next_job', {
    p_worker_id: config.worker.id,
    p_queue_name: config.worker.queueName,
    p_lock_seconds: config.worker.lockSeconds,
    p_integrations: config.worker.integrations,
  });

  if (error) throw new Error(`claim_next_job RPC failed: ${error.message}`);

  // RPC returns a table row; supabase-js wraps it in an array
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  return row as Job;
}

/** Fetches all steps for a job, ordered by step_index. */
export async function getJobSteps(jobId: string): Promise<JobStep[]> {
  const { data, error } = await supabase
    .from('job_steps')
    .select('*')
    .eq('job_id', jobId)
    .order('step_index', { ascending: true });

  if (error) throw new Error(`getJobSteps failed: ${error.message}`);

  return (data ?? []) as unknown as JobStep[];
}

/** Releases the lock on a job, returning it to pending state. */
export async function releaseJobLock(jobId: string): Promise<void> {
  await supabase.rpc('release_job_lock', { p_job_id: jobId });
}
