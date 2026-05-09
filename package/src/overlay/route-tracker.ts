// Watch SPA route changes so the overlay knows the "current URL" for pinning.
// Patches pushState/replaceState (which don't fire popstate by themselves)
// and emits a synthetic event the overlay subscribes to.

const EVENT = 'margo:routechange';

export function installRouteTracker(): () => void {
  const wrap = (orig: typeof history.pushState | typeof history.replaceState) => {
    return function (this: History, ...args: Parameters<typeof orig>) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event(EVENT));
      return ret;
    } as typeof orig;
  };
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = wrap(origPush);
  history.replaceState = wrap(origReplace);
  const onPop = () => window.dispatchEvent(new Event(EVENT));
  window.addEventListener('popstate', onPop);
  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener('popstate', onPop);
  };
}

export function onRouteChange(handler: () => void): () => void {
  const wrapped = () => handler();
  window.addEventListener(EVENT, wrapped);
  return () => window.removeEventListener(EVENT, wrapped);
}

export function currentRoute(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}
