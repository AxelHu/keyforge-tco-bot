/** A separately authorized reconciliation never pretends the old worker exited successfully. */
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function verifiedUnjoinedReconciliation(receipt, { gameId, selfName, attemptId }) {
  return Boolean(
    receipt?.schema === 'kf-unjoined-reconciliation-v1' &&
      receipt.status === 'verified-retired' &&
      receipt.gameId === gameId &&
      receipt.playerName === selfName &&
      receipt.attemptId === attemptId &&
      receipt.operatorRecovery?.action === 'retire-unjoined-attempt' &&
      receipt.operatorRecovery.source === 'explicit-operator-reconciliation' &&
      receipt.operatorRecovery.acknowledgedLegacyStopSourceUnknown === true &&
      receipt.legacyStopProvenance === 'unknown' &&
      receipt.originalDriverExit === 'nonzero-or-unverified-not-assumed-successful' &&
      receipt.preJoinGuard === 'CURRENT_PUBLIC_LISTING_NOT_OBSERVED' &&
      receipt.neverNativeActive === true &&
      receipt.zeroGameplaySends === true &&
      receipt.nativeAbsence?.nativeFullRoster === true &&
      receipt.nativeAbsence.source === 'native-lobby' &&
      receipt.nativeAbsence.anonymous === true &&
      Array.isArray(receipt.nativeAbsence.rooms) &&
      receipt.nativeAbsence.rooms.every((room) => room.players && !Object.hasOwn(room.players, selfName)) &&
      ['parent', 'driver', 'host', 'browser'].every(
        (key) =>
          receipt.processes?.[key]?.exited === true &&
          Number.isSafeInteger(receipt.processes[key].pid) &&
          receipt.processes[key].pid > 0,
      ) &&
      ['account', 'host', 'browser'].every((key) => receipt.locks?.[key] === true) &&
      sha(receipt.requestSha256) &&
      sha(receipt.configSha256) &&
      sha(receipt.operatorRecovery.stopReceiptSha256) &&
      sha(receipt.reconciliationToolSha256) &&
      sha(receipt.originalCheckpointSha256) &&
      sha(receipt.originalHandoffSha256) &&
      sha(receipt.runtimeManifestSha256) &&
      sha(receipt.originalRecordsSha256),
  );
}
