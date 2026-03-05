/**
 * Sahayog AI — NPA Worker
 * Full IRAC classification per RBI norms.
 * Runs daily via BullMQ; also callable from jobs.ts.
 */
import { Worker, Job } from "bullmq";
/**
 * Full IRAC classification job.
 * For each active/NPA loan:
 *   1. Find oldest overdue EMI → compute DPD
 *   2. Classify into NPA bucket
 *   3. Compute required provision amount
 *   4. Post quarterly provision GL if changed
 *   5. Move interest to suspense for NPA loans (monthly)
 */
export declare function processNpa(job: Job<{
    tenantId?: string;
}>): Promise<{
    classified: number;
    provisioned: number;
    suspensePosted: number;
    tenantId: string | undefined;
    period: string;
}>;
export declare function startNpaWorker(): Worker<any, any, string>;
//# sourceMappingURL=npa.d.ts.map