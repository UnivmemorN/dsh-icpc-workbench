/**
 * Solved-distribution histogram rules (Sprint Contract 07b repair 1).
 *
 * These are the pure chart decisions `SolvedDistribution.tsx` renders: which series a reader sees
 * by default, and how long a bar is. No DOM is involved, so the contract is exercised directly
 * instead of being weakened to a markup snapshot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  barWidthPercent,
  histogramPeak,
  pickHistogramSeries,
  type HistogramSeries,
} from '../../src/ui/histogram.js';

/** One series with the exact shape the business API returns. */
function series(
  dimension: string,
  buckets: readonly (readonly [number, number])[],
  knownCount: number,
  unknownCount: number,
): HistogramSeries {
  return {
    dimension,
    buckets: buckets.map(([value, count]) => ({ value, count })),
    knownCount,
    unknownCount,
  };
}

void test('an explicit series choice always wins, including an all-unknown series', () => {
  const rating = series('rating', [[1800, 3]], 3, 1);
  const difficulty = series('difficulty', [], 0, 4);

  assert.equal(pickHistogramSeries([rating, difficulty], null)?.dimension, 'rating');
  assert.equal(
    pickHistogramSeries([rating, difficulty], 'difficulty')?.dimension,
    'difficulty',
    'an explicitly chosen all-unknown series stays selected',
  );
  assert.equal(
    pickHistogramSeries([rating, difficulty], 'vanished')?.dimension,
    'rating',
    'a choice that no longer exists falls back to the default instead of rendering nothing',
  );
  assert.equal(pickHistogramSeries([], null), null);
});

void test('an all-unknown default yields to the first known series', () => {
  const difficulty = series('difficulty', [], 0, 4);
  const rating = series('rating', [[1200, 2]], 2, 2);
  const manual = series('manual', [[5, 4]], 4, 0);

  assert.equal(
    pickHistogramSeries([difficulty, rating, manual], null)?.dimension,
    'rating',
    'the expected dimension having no value must not hide a series the source really reports',
  );
  assert.equal(
    pickHistogramSeries([difficulty], null)?.dimension,
    'difficulty',
    'all-unknown evidence still renders as its own explicit series',
  );
  assert.equal(pickHistogramSeries([difficulty, rating], 'difficulty')?.dimension, 'difficulty');
});

void test('bar length is exactly count / peak and the unknown row joins the peak', () => {
  const row = series('rating', [[1800, 3], [2400, 1]], 4, 2);
  assert.equal(histogramPeak(row), 3, 'the peak ignores buckets and unknown rows that are smaller');
  assert.equal(barWidthPercent(3, 3), 100);
  assert.equal(
    barWidthPercent(1, 3),
    (1 / 3) * 100,
    'a small bucket keeps its exact ratio instead of an artificial 2% floor',
  );
  assert.equal(barWidthPercent(0, 3), 0);
  assert.equal(barWidthPercent(-2, 3), 0);
  assert.equal(barWidthPercent(5, 0), 0, 'a degenerate peak never divides by zero');

  const unknownHeavy = series('rating', [[1800, 1]], 1, 4);
  assert.equal(histogramPeak(unknownHeavy), 4, 'the unknown row is a bar and counts toward the peak');
  assert.equal(barWidthPercent(unknownHeavy.unknownCount, histogramPeak(unknownHeavy)), 100);
  assert.equal(histogramPeak(series('empty', [], 0, 0)), 1, 'an empty series still has a safe peak');
});
