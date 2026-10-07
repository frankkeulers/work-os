import { describe, expect, it } from 'vitest';
import { matchLookup, personKey } from './lookup';

const PEOPLE = [{ value: 'Dana Lee' }, { value: 'dlee', detail: 'Daniel Leeds' }, { value: 'Matt M.', detail: 'Matthew Morgan' }, { value: 'Sam Okafor' }];
const names = (q: string, exclude: string[] = []) => matchLookup(PEOPLE, q, exclude, personKey).map((o) => o.value);

describe('people search', () => {
  it('ranks names starting with the text, then any word of the name or real name, then the rest', () => {
    expect(names('d')).toEqual(['Dana Lee', 'dlee']);
    expect(names('lee')).toEqual(['Dana Lee', 'dlee']); // a word of the name, then of the real name
    expect(names('MORGAN')).toEqual(['Matt M.']);
    expect(names('kaf')).toEqual(['Sam Okafor']);
  });

  it('leaves out people already picked, ignoring case', () => {
    expect(names('d', ['dana lee'])).toEqual(['dlee']);
  });
});
