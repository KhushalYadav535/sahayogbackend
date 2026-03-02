/**
 * BullMQ NPA job — marks loans 90+ days overdue as NPA
 */
import { Worker, Job } from "bullmq";
export declare function processNpa(job: Job<{
    tenantId?: string;
}>): Promise<{
    marked: number;
    tenantId: string | undefined;
}>;
export declare function startNpaWorker(): Worker<any, any, string>;
//# sourceMappingURL=npa.d.ts.map