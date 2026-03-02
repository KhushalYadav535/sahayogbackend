/**
 * BullMQ day-end job — applies daily SB interest
 * Scheduled via BullMQ; can also be triggered via POST /api/v1/jobs/day-end
 */
import { Worker, Job } from "bullmq";
export declare function processDayEnd(job: Job<{
    tenantId: string;
}>): Promise<{
    processed: number;
    tenantId: string;
}>;
export declare function startDayEndWorker(): Worker<any, any, string>;
//# sourceMappingURL=day-end.d.ts.map