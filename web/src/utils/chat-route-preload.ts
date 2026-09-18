export function shouldPreloadChatRoute(
  pathname: string,
  hash: string,
  appBase: string,
): boolean {
  const hashRoute = hash.startsWith('#/') ? hash.slice(1) : '';
  let route = hashRoute || pathname || '/';
  route = route.split(/[?#]/, 1)[0] || '/';

  if (!hashRoute && appBase !== '/') {
    const base = appBase.endsWith('/') ? appBase.slice(0, -1) : appBase;
    if (route === base) {
      route = '/';
    } else if (route.startsWith(`${base}/`)) {
      route = route.slice(base.length) || '/';
    }
  }

  return route === '/' || route === '/chat' || route.startsWith('/chat/');
}
