import { describe, expect, it } from 'vitest';
import { initialsOf, shownName } from './profile';

describe('shownName', () => {
  it('prefers the display name, then first and last name, then none', () => {
    expect(shownName({ firstName: 'Frank', lastName: 'Keulers', displayName: 'FK' })).toBe('FK');
    expect(shownName({ firstName: 'Frank', lastName: 'Keulers' })).toBe('Frank Keulers');
    expect(shownName({ lastName: 'Keulers' })).toBe('Keulers');
    expect(shownName({ displayName: '   ', firstName: ' Frank ' })).toBe('Frank');
    expect(shownName({})).toBeUndefined();
  });
});

describe('initialsOf', () => {
  it('takes first and last name, else the display name’s first and last words', () => {
    expect(initialsOf({ firstName: 'frank', lastName: 'keulers' })).toBe('FK');
    expect(initialsOf({ firstName: 'Frank' })).toBe('F');
    expect(initialsOf({ displayName: 'Anna van der Berg' })).toBe('AB');
    expect(initialsOf({ displayName: 'Ölaf' })).toBe('Ö');
    expect(initialsOf({ firstName: '  ', displayName: '' })).toBeUndefined();
  });
});
