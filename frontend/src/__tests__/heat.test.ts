import { describe, it, expect } from 'vitest';
import { heatScale } from '../lib/heat';

const levels = (scale: (n: number) => number, counts: number[]) => counts.map(scale);

describe('heatScale', () => {
  it('uses fixed thresholds without a filter', () => {
    const heat = heatScale([0, 1, 3, 8, 20, 40], false);
    expect(levels(heat, [0, 1, 5, 6, 15, 16, 30, 31, 100])).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('keeps fixed thresholds when every day has the same few clips', () => {
    const heat = heatScale([2, 2, 2, 2], false);
    expect(levels(heat, [1, 2, 6])).toEqual([1, 1, 2]);
  });

  it('switches to quartiles without a filter when days average more than 15 clips', () => {
    // Fixed thresholds would make nearly every day the darkest shade.
    const counts = [20, 30, 40, 50, 60, 70, 80, 90];
    const heat = heatScale([0, ...counts], false);
    expect(levels(heat, counts)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('is relative to the days on screen with a filter', () => {
    // A game filter's busy days spread over all four shades, not just the darkest.
    const counts = [3, 4, 6, 8, 9, 10, 12, 14];
    const heat = heatScale(counts, true);
    expect(levels(heat, counts)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('steps one shade per clip when a filter leaves a clip or two a day', () => {
    // Quartiles alone would be [1, 1, 1]: one clip lightest, two the darkest.
    const heat = heatScale([1, 1, 1, 1, 1, 1, 2, 1, 0, 0], true);
    expect(levels(heat, [0, 1, 2, 3, 4, 9])).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it('shades nothing when no day has clips', () => {
    expect(heatScale([], true)(0)).toBe(0);
    expect(heatScale([0, 0], false)(0)).toBe(0);
  });
});
