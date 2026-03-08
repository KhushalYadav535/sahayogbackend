/**
 * Sahayog AI — Day-End Worker (BullMQ)
 * Runs the comprehensive daily end-of-day jobs:
 *   - SB interest accrual (daily product method)
 *   - FDR/RD daily interest accrual
 *   - MIS monthly payout (1st of month)
 *   - Dormant account reclassification (24 months)
 *   - EMI overdue marking
 *   - Suspense entry age alerts
 *   - Unclaimed deposit tracking (DEAF approach)
 */
import { Worker, Job } from "bullmq";
export declare function processDayEnd(job: Job<{
    tenantId: string;
}>): Promise<{
    tenantId: string;
    period: string;
    sbAccrualsPosted: number;
    fdrAccrualsPosted: number;
    rdAccrualsPosted: number;
    rdInstallmentsCollected: number;
    rdInstallmentsMissed: number;
    misPayoutsPosted: number;
    sweepInsExecuted: number;
    sweepOutsExecuted: number;
    overdueEmisMarked: any;
    dormantAccountsMarked: any;
    overdueSuspenseAlerts: any;
    deafApproachingDeposits: any;
    bodAlertsSent: any;
    actionItemsEscalated: number;
}>;
export declare function startDayEndWorker(): Worker<any, any, string>;
//# sourceMappingURL=day-end.d.ts.map