import { createHash } from 'node:crypto';

export const syncDigest=issue=>createHash('sha256').update(`${issue.title}\n${issue.body||''}\n${issue.user?.login||''}`).digest('hex');
export function appliedSyncIssue(state,issue){
  return state.appliedSyncIssues?.[issue.number]?.digest===syncDigest(issue);
}

// Acknowledgements are made only by a workflow step after successful deployment.
// Keep the receipt in the encrypted baseline so cancellation/retry is idempotent.
export async function acknowledgePublishedSync({state,listIssues,closeIssue,requestScan}){
  const issues=await listIssues();
  const confirmed=issues.filter(issue=>appliedSyncIssue(state,issue));
  if(requestScan&&confirmed.some(issue=>state.appliedSyncIssues[issue.number].needsScan))await requestScan();
  for(const issue of confirmed)await closeIssue(issue.number);
  return confirmed.length;
}
