export interface SaveReconciliation<TConfig> { draftConfig: TConfig }

/**
 * A save acknowledgement may only replace the visible draft when no edit
 * happened after the request was sent. The caller owns the saved baseline.
 */
export function reconcileSave<TConfig>(input: {
  acknowledgement: TConfig;
  currentDraftConfig: TConfig;
  submittedRevision: number;
  currentRevision: number;
}): SaveReconciliation<TConfig> {
  const draftIsCurrent = input.currentRevision === input.submittedRevision;
  return {
    draftConfig: draftIsCurrent ? input.acknowledgement : input.currentDraftConfig
  };
}
