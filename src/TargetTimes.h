/*
 * Manages standard and custom exposure-time denominator lists used by the device and API.
 */

#pragma once
#include <Arduino.h>
#include "Config.h"

enum class TargetSeries : uint8_t {
  Standard,
  Custom
};

static constexpr int TARGET_TIMES_MAX_COUNT = 16;

#define TARGET_TIMES_STANDARD_VALUES 1, 2, 4, 8, 15, 30, 60, 125, 250, 500, 1000, 2000
#define TARGET_TIMES_CUSTOM_DEFAULT_VALUES 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000

static constexpr int TARGET_TIMES_STANDARD[] = { TARGET_TIMES_STANDARD_VALUES };
static constexpr int TARGET_TIMES_STANDARD_COUNT = sizeof(TARGET_TIMES_STANDARD) / sizeof(TARGET_TIMES_STANDARD[0]);

static constexpr int TARGET_TIMES_CUSTOM_DEFAULT[] = { TARGET_TIMES_CUSTOM_DEFAULT_VALUES };
static constexpr int TARGET_TIMES_CUSTOM_DEFAULT_COUNT = sizeof(TARGET_TIMES_CUSTOM_DEFAULT) / sizeof(TARGET_TIMES_CUSTOM_DEFAULT[0]);

// Validates compile-time target lists against firmware limits before the build can succeed.
template<int... Values> struct TargetTimesWithinDeviceLimit;

template<>
struct TargetTimesWithinDeviceLimit<> {
  static constexpr bool value = true;
};

template<int First, int... Rest>
struct TargetTimesWithinDeviceLimit<First, Rest...> {
  static constexpr bool value =
      First > 0 &&
      First <= DEVICE_MAX_TARGET_TIME &&
      TargetTimesWithinDeviceLimit<Rest...>::value;
};

static_assert(TargetTimesWithinDeviceLimit<TARGET_TIMES_STANDARD_VALUES>::value,
              "TARGET_TIMES_STANDARD contains values outside DEVICE_MAX_TARGET_TIME");
static_assert(TargetTimesWithinDeviceLimit<TARGET_TIMES_CUSTOM_DEFAULT_VALUES>::value,
              "TARGET_TIMES_CUSTOM_DEFAULT contains values outside DEVICE_MAX_TARGET_TIME");
static_assert(TARGET_TIMES_STANDARD_COUNT <= TARGET_TIMES_MAX_COUNT,
              "TARGET_TIMES_STANDARD exceeds TARGET_TIMES_MAX_COUNT");
static_assert(TARGET_TIMES_CUSTOM_DEFAULT_COUNT <= TARGET_TIMES_MAX_COUNT,
              "TARGET_TIMES_CUSTOM_DEFAULT exceeds TARGET_TIMES_MAX_COUNT");

static int g_customTargetTimes[TARGET_TIMES_MAX_COUNT];
static int g_customTargetTimesCount = TARGET_TIMES_CUSTOM_DEFAULT_COUNT;

// Restores the default custom target-time denominator list.
static inline void resetCustomTargetTimes() {
  g_customTargetTimesCount = TARGET_TIMES_CUSTOM_DEFAULT_COUNT;
  for (int i = 0; i < g_customTargetTimesCount; i++) g_customTargetTimes[i] = TARGET_TIMES_CUSTOM_DEFAULT[i];
}

// Sorts a small target-time list in ascending order.
static inline void sortTargetTimes(int* values, int count) {
  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (values[j] < values[i]) {
        const int t = values[i];
        values[i] = values[j];
        values[j] = t;
      }
    }
  }
}

// Store custom values. maxTargetTime is the device-specific limit for saving
// custom times only; it does not limit navigation through already active lists.
// Filters, de-duplicates, sorts, and stores custom target-time denominators.
static inline void setCustomTargetTimes(const int* values, int count, int maxTargetTime = 0) {
  if (!values || count <= 0) {
    resetCustomTargetTimes();
    return;
  }

  int tmp[TARGET_TIMES_MAX_COUNT];
  int n = 0;
  for (int i = 0; i < count && n < TARGET_TIMES_MAX_COUNT; i++) {
    const int v = values[i];
    if (v <= 0) continue;
    if (maxTargetTime > 0 && v > maxTargetTime) continue;

    bool exists = false;
    for (int j = 0; j < n; j++) {
      if (tmp[j] == v) {
        exists = true;
        break;
      }
    }
    if (!exists) tmp[n++] = v;
  }

  if (n <= 0) {
    for (int i = 0; i < TARGET_TIMES_CUSTOM_DEFAULT_COUNT && n < TARGET_TIMES_MAX_COUNT; i++) {
      const int v = TARGET_TIMES_CUSTOM_DEFAULT[i];
      if (maxTargetTime <= 0 || v <= maxTargetTime) tmp[n++] = v;
    }
    if (n <= 0) tmp[n++] = max(1, maxTargetTime);
  }

  sortTargetTimes(tmp, n);
  g_customTargetTimesCount = n;
  for (int i = 0; i < n; i++) g_customTargetTimes[i] = tmp[i];
}

// Returns the active array for the requested target-time series.
static inline const int* targetTimesForSeries(TargetSeries series) {
  return series == TargetSeries::Custom ? g_customTargetTimes : TARGET_TIMES_STANDARD;
}

// Returns the number of target times in the requested series.
static inline int targetTimesCountForSeries(TargetSeries series) {
  return series == TargetSeries::Custom ? g_customTargetTimesCount : TARGET_TIMES_STANDARD_COUNT;
}

// Returns the largest denominator in the requested series.
static inline int maxTargetTimeForSeries(TargetSeries series) {
  const int count = targetTimesCountForSeries(series);
  const int* times = targetTimesForSeries(series);
  return count > 0 ? times[count - 1] : DEFAULT_TARGET_TIME;
}

// Converts a target series enum value to its stable API/settings key.
static inline const char* targetSeriesKey(TargetSeries series) {
  return series == TargetSeries::Custom ? "custom" : "standard";
}

// Parses a target series key and falls back to the standard list.
static inline TargetSeries targetSeriesFromKey(const String& key) {
  return key == "custom" ? TargetSeries::Custom : TargetSeries::Standard;
}

// Returns the next target series in the local menu cycle.
static inline TargetSeries nextTargetSeries(TargetSeries series) {
  return series == TargetSeries::Standard ? TargetSeries::Custom : TargetSeries::Standard;
}

// Returns a clamped target denominator from a series.
static inline int targetTimeAt(int index, TargetSeries series = TargetSeries::Standard) {
  const int count = targetTimesCountForSeries(series);
  const int* times = targetTimesForSeries(series);
  if (count <= 0) return DEFAULT_TARGET_TIME;
  if (index < 0) index = 0;
  if (index >= count) index = count - 1;
  return times[index];
}

// Returns the highest valid index for a target-time series.
static inline int maxTargetIndex(TargetSeries series = TargetSeries::Standard) {
  const int count = targetTimesCountForSeries(series);
  return count > 0 ? count - 1 : 0;
}

// Finds the exact or nearest index for a target denominator.
static inline int targetIndexForTime(int target, TargetSeries series = TargetSeries::Standard) {
  const int* times = targetTimesForSeries(series);
  const int count = targetTimesCountForSeries(series);
  if (count <= 0) return 0;

  for (int i = 0; i < count; i++) {
    if (times[i] == target) return i;
  }

  int best = 0;
  int bestDiff = abs(times[0] - target);
  for (int i = 1; i < count; i++) {
    const int d = abs(times[i] - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}
