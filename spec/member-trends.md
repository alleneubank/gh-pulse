# Member Trend Spec

## Goal

Trend values in member breakdown should reflect recent momentum without being distorted by partial trailing buckets.

## Activity Definition

Per bucket activity is:

`activity = prs_opened + prs_merged + prs_closed + commits + reviews`

Lines changed are not part of activity trend.

## Trend Calculation

Trend is based on activity **rate per day**, not raw bucket totals.

- `activity_rate_per_day = activity / bucket_days`
- `delta_pct = ((current_rate - previous_rate) / previous_rate) * 100`

Special cases:

- If both rates are 0, `delta_pct = 0`
- If previous rate is 0 and current rate is > 0, `delta_pct = 100`

## Partial Bucket Handling

When the latest bucket is partial and at least two complete buckets exist:

- Skip the latest partial bucket for member breakdown trend
- Compare the two most recent complete buckets

If two complete buckets do not exist, compare the latest two buckets using rate-per-day normalization.

## Arrow Thresholds

- `▲` when `delta_pct > 10`
- `▼` when `delta_pct < -10`
- `→` otherwise
