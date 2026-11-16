/** Install only the GM request behavior used by the production browser bridge. */
function installBridgeRequest() {
  window.GM_xmlhttpRequest = (request) => {
    const { onload, onerror, ontimeout, ...data } = request;
    let settled = false,
      timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof callback === 'function') callback(value);
    };
    if (Number.isFinite(data.timeout) && data.timeout > 0)
      timer = setTimeout(() => finish(ontimeout), data.timeout);
    // This deadline fences browser callbacks; it does not cancel an already accepted host write.
    // Fence before onload, which may update owner receipts or clear a persisted send ledger.
    try {
      Promise.resolve(window.__kfGMRequest(data)).then(
        (response) => finish(onload, response),
        (error) => finish(onerror, error),
      );
    } catch (error) {
      finish(onerror, error);
    }
  };
}

/** Bootstrap the real userscript in the one-seat launcher and browser fixtures. */
export function userscriptBootstrap(settings, source) {
  return (
    'window.unsafeWindow=window;window.GM_getValue=()=>(' +
    JSON.stringify(settings) +
    ');' +
    'window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>{};' +
    '(' +
    installBridgeRequest.toString() +
    ')();\n' +
    source
  );
}
