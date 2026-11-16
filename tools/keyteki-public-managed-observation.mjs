import { validateKeytekiManagedFullState } from './keyteki-wire-session.mjs';

export function staleManagedBridgeState(next, previous) {
  if (!next?.managed || !previous?.managed || next.gameId !== previous.gameId) return false;
  if (next.ownerEpoch !== previous.ownerEpoch) return next.ownerEpoch < previous.ownerEpoch;
  if (next.nodeSequence !== previous.nodeSequence) return next.nodeSequence < previous.nodeSequence;
  return (
    Number.isSafeInteger(next.receiptOrdinal) &&
    Number.isSafeInteger(previous.receiptOrdinal) &&
    next.receiptOrdinal < previous.receiptOrdinal
  );
}

/** An observer mirrors only Node-accepted frames, with document and node ordinals kept separate. */
export function acceptManagedPublicFrame(stream, route, request, state, identity) {
  if (
    !state?.managed ||
    state.gameId !== identity.gameId ||
    state.documentId !== (request.documentId ?? request.sessionId) ||
    !Number.isSafeInteger(state.ownerEpoch) ||
    !Number.isSafeInteger(state.nodeSequence)
  )
    throw Error('Managed public frame lacks an accepted ownership receipt');
  const previous = stream.managedObservation;
  if (previous && (state.ownerEpoch < previous.ownerEpoch || state.nodeSequence <= previous.nodeSequence))
    return { ignored: true, reason: 'late-accepted-receipt', raw: stream.root };
  if (route === '/attach' || route === '/transport-resume') {
    const proof = validateKeytekiManagedFullState(stream.root, request.fullState, identity);
    const receipt = state.resumeReceipt;
    if (
      receipt?.kind !== proof.kind ||
      receipt.afterStateSha256 !== proof.afterStateSha256 ||
      receipt.gameId !== identity.gameId ||
      receipt.playerName !== identity.playerName ||
      receipt.sequence !== state.nodeSequence ||
      state.sequence !== request.sequence ||
      receipt.transport?.path !== request.transport?.path ||
      receipt.transport?.epoch !== request.transport?.epoch
    )
      throw Error('Managed public attach does not match its native full-state receipt');
    const observedGap = Boolean(previous && receipt.beforeStateSha256 !== proof.beforeStateSha256);
    const { raw } = stream.replaceManagedFull(request.fullState, stream.sequence + 1, identity);
    stream.managedObservation = {
      ownerEpoch: state.ownerEpoch,
      documentId: state.documentId,
      nodeSequence: state.nodeSequence,
    };
    return { raw, fullState: true, observedGap, receipt };
  }
  if (
    route !== '/state' ||
    !previous ||
    previous.ownerEpoch !== state.ownerEpoch ||
    previous.documentId !== state.documentId ||
    state.nodeSequence !== previous.nodeSequence + 1 ||
    state.sequence !== request.sequence
  )
    throw Error('Managed public delta requires the current document and contiguous Node sequence');
  const raw = stream.receive(request.delta, stream.sequence + 1);
  stream.managedObservation = { ...previous, nodeSequence: state.nodeSequence };
  return { raw, fullState: false };
}
