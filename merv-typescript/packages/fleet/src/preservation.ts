/** Internal operator preservation contract. No public tool or route registers these operations. */
import {z} from 'zod';
const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const preservationIdentity=z.strictObject({
 projectId:id,allocationId:id,epoch:z.number().int().nonnegative(),runnerId:id,sessionId:id,
 hostRef:id,generation:z.number().int().positive(),leaseId:id,unitId:id,
 nativeId:id,nativeUuid:id,nativeCreatedAt:id,image:id,appVersion:z.number().int().nonnegative(),
 sandboxId:id,startedAt:id,launchId:id,jobId:id,
});
export const preservationRequest=z.strictObject({operationId:id,identity:preservationIdentity,
 sourceBindingSha256:hash,expiresAt:z.string().datetime()});
export type PreservationRequest=z.infer<typeof preservationRequest>;
export interface PreservationFence extends PreservationRequest {
 requestedAt:string;
 /** Server fence only. It neither freezes a process nor attests native metadata. */
 quiesced:false;
 lifecycleBarrierVerified:false;
 nativeIdentityVerified:false;
}
