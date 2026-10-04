import type { Artifacts, Caller, Reviews, Tasks, TaskDelivery, TaskReview } from '@merv/contracts';
import { currentWork } from './current-work.js';
import { confirmedDelivery, reviewedFindings } from './task-evidence.js';

type Host = Parameters<typeof currentWork>[0] & {
  tasks: Tasks;
  artifacts: Artifacts;
  reviews: Reviews;
};
/** Deliver through a real worker checkout, then optionally review through a separate lease. */
export async function deliverCurrentTask(
  host: Host,
  directory: string,
  source: Caller,
  taskId: string,
  reviewer?: Caller,
) {
  const work = currentWork(host, { directory, source });
  try {
    const task = await host.tasks.get(source, taskId);
    const worker = await work.lease(task);
    const proof = await work.run(
      worker,
      'artifact.create',
      {
        title: 'Delivery',
        content: 'Check feasibility: report outcome. Reproduced 2+2=4.',
      },
      (caller, input) => host.artifacts.create(caller, input as never),
    );
    const commandId = await work.commit(worker);
    const submitted = await work.run(
      worker,
      'task.submit_delivery',
      confirmedDelivery(
        {
          taskId,
          expectedRevision: task.workflow.revision,
          artifactIds: [proof.id],
          commandId,
          requestId: work.request(),
        },
        task.checks.length,
      ),
      (caller, input) => host.tasks.submitDelivery(caller, input as unknown as TaskDelivery),
    );
    await work.release(worker);
    if (!reviewer) return { task: submitted, proof };
    const lease = await work.lease(submitted, reviewer);
    const review = await host.reviews.get(lease.worker, submitted.reviewId!);
    const accepted = await work.run(
      lease,
      'review.submit',
      {
        ...reviewedFindings(review),
        reviewId: review.id,
        claimId: review.claimId!,
        expectedRevision: submitted.workflow.revision,
        verdict: 'pass',
        notes: 'Independently verified the retained result.',
        requestId: work.request(),
      },
      (caller, input) => host.tasks.submitReview(caller, input as unknown as TaskReview),
    );
    await work.release(lease);
    return { task: accepted, proof };
  } finally {
    await work.close();
  }
}
