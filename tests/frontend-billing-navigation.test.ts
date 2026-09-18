import { describe, expect, test } from 'vitest';

import { filterNavItems } from '../web/src/components/layout/nav-items.js';

describe('billing navigation visibility', () => {
  test('does not expose billing in the main navigation while billing is disabled', () => {
    expect(filterNavItems(false).some((item) => item.path === '/billing')).toBe(
      false,
    );
  });

  test('shows only the user-facing bill entry when billing is enabled', () => {
    expect(
      filterNavItems(true).find((item) => item.path === '/billing'),
    ).toEqual(expect.objectContaining({ label: '费用中心' }));
  });
});
