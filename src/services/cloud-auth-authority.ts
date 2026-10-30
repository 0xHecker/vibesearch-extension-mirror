import { z } from "zod";
import { cloudAuthService, type CloudAuthService, useLocalCloudAuthAuthority } from "./cloud-auth";

const connectionRequestSchema = z.object({ forceRefresh: z.boolean().default(false) });
const leaseRequestSchema = z.object({ leaseId: z.string().min(1).max(200) });
const rejectionRequestSchema = leaseRequestSchema.extend({ token: z.string().min(1).max(64 * 1024) });

export const createCloudAuthAuthority = (service: CloudAuthService = cloudAuthService) => {
  if (service === cloudAuthService) useLocalCloudAuthAuthority();
  return {
    connection(payload: unknown) {
      return service.getConnection(connectionRequestSchema.parse(payload ?? {}).forceRefresh);
    },
    validateConnection(payload: unknown) {
      return service.validateConnection(leaseRequestSchema.parse(payload).leaseId);
    },
    rejectConnection(payload: unknown) {
      const { leaseId, token } = rejectionRequestSchema.parse(payload);
      return service.markSessionRejected(leaseId, token);
    },
  };
};
