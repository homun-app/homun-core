"use strict";
// Gateway restart policy. Pure on purpose: the caller passes the timestamps
// (ms) of previous respawns and "now"; we return how long to wait before the
// next respawn, or null when the crash-loop budget is exhausted and the shell
// must surface an error dialog instead of silently burning CPU.
const WINDOW_MS = 5 * 60 * 1000;
const DELAYS_MS = [1_000, 5_000, 15_000];

function nextRestartDelay(restartTimestamps, now) {
  const recent = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= DELAYS_MS.length) return null;
  return DELAYS_MS[recent.length];
}

module.exports = { nextRestartDelay, WINDOW_MS, DELAYS_MS };
