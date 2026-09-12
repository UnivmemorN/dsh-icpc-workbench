/**
 * Pure histogram rules of the solved-problem distribution (Stage 07b repair 1).
 *
 * Kept outside the React component so the two externally meaningful chart decisions — which series
 * a reader sees by default and how long one bar is — are unit-checkable without a DOM. Nothing here
 * reads a store, a clock or a model; the same series always renders the same way.
 */

/** One numeric bucket of a series, exactly as the business API returns it. */
export interface HistogramBucket {
  readonly value: number;
  readonly count: number;
}

/** One raw dimension series of the solved distribution, exactly as the business API returns it. */
export interface HistogramSeries {
  /** Original platform dimension name. */
  readonly dimension: string;
  /** Numeric buckets ascending by value. */
  readonly buckets: readonly HistogramBucket[];
  readonly knownCount: number;
  readonly unknownCount: number;
}

/**
 * The series one histogram shows.
 *
 * An explicit `picked` label always wins while that series still exists — including an all-unknown
 * series the reader deliberately selected. Without a choice the first series (the source's expected
 * dimension) is the default; when that default has no usable value at all but another series does,
 * the first known series is shown instead, so an all-unknown expected dimension cannot hide the
 * numbers the source really reports. Only when no series has a known value does the default stay.
 */
export function pickHistogramSeries(
  dimensions: readonly HistogramSeries[],
  picked: string | null,
): HistogramSeries | null {
  if (picked !== null) {
    const explicit = dimensions.find((entry) => entry.dimension === picked);
    if (explicit !== undefined) {
      return explicit;
    }
  }
  const [first] = dimensions;
  if (first === undefined) {
    return null;
  }
  if (first.knownCount > 0) {
    return first;
  }
  return dimensions.find((entry) => entry.knownCount > 0) ?? first;
}

/** Tallest bar of one series, at least 1, so the widest bar is 100% and a peak is never zero. */
export function histogramPeak(series: HistogramSeries): number {
  return Math.max(1, series.unknownCount, ...series.buckets.map((bucket) => bucket.count));
}

/**
 * Exact relative bar width in percent: `count / peak * 100`, with no artificial minimum.
 *
 * A count of zero (or a degenerate peak) is `0`; every other count keeps its true ratio, so a bar
 * never claims more share than the printed count supports.
 */
export function barWidthPercent(count: number, peak: number): number {
  if (!(count > 0) || !(peak > 0)) {
    return 0;
  }
  return (count / peak) * 100;
}
