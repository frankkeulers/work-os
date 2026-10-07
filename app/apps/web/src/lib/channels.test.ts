import { describe, expect, it } from 'vitest';
import { matchChannels } from './channels';

const ALL = ['#general', '#meridia-product', '#meridia-signals', '#product-leads', '#product-signals'];

describe('channel search', () => {
  it('matches without the "#", ignoring case, names starting with the text first', () => {
    expect(matchChannels(ALL, 'SIG', [])).toEqual(['#meridia-signals', '#product-signals']);
    expect(matchChannels(ALL, 'prod', [])).toEqual(['#product-leads', '#product-signals', '#meridia-product']);
    expect(matchChannels(ALL, '#prod', [])).toEqual(['#product-leads', '#product-signals', '#meridia-product']);
  });

  it('leaves out channels already picked, with or without their "#"', () => {
    expect(matchChannels(ALL, 'product', ['product-leads', '#meridia-product'])).toEqual(['#product-signals']);
  });

  it('shows the first eight when nothing is typed', () => {
    const many = Array.from({ length: 12 }, (_, i) => `#c${i}`);
    expect(matchChannels(many, ' ', [])).toHaveLength(8);
  });
});
