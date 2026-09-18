export interface NavigationLocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

export interface UnsavedNavigationGuard {
  allowNext: (location: NavigationLocationLike) => number;
  cancelAllowance: (token: number) => void;
  shouldBlock: (
    hasUnsavedChanges: boolean,
    currentLocation: NavigationLocationLike,
    nextLocation: NavigationLocationLike,
  ) => boolean;
}

export function navigationLocationKey(
  location: NavigationLocationLike,
): string {
  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
}

/**
 * One-shot bypasses let already-confirmed in-page actions update their query
 * string without prompting twice. Every other push/replace/pop navigation is
 * blocked while the form is dirty.
 */
export function createUnsavedNavigationGuard(): UnsavedNavigationGuard {
  let allowance: { key: string; token: number } | null = null;
  let nextToken = 0;

  return {
    allowNext(location) {
      const token = ++nextToken;
      allowance = { key: navigationLocationKey(location), token };
      return token;
    },
    cancelAllowance(token) {
      if (allowance?.token === token) allowance = null;
    },
    shouldBlock(hasUnsavedChanges, currentLocation, nextLocation) {
      const currentKey = navigationLocationKey(currentLocation);
      const nextKey = navigationLocationKey(nextLocation);
      if (currentKey === nextKey) return false;
      if (allowance?.key === nextKey) {
        allowance = null;
        return false;
      }
      return hasUnsavedChanges;
    },
  };
}
