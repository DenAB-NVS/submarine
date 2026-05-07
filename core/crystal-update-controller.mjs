/**
 * Crystal Update Controller — event-driven generation.
 *
 * markCrystalDirty() → debounce 5 min → generateCrystal()
 * + safety cron every 6 hours
 *
 */

import { getConfig } from '../src/config.mjs';
import { generateCrystal } from './crystal.mjs';

let crystalDirty = false;
let lastChangeAt = 0;
let lastGeneration = Date.now();
let isGenerating = false;
let intervalId = null;

export function markCrystalDirty(reason = 'unknown') {
  crystalDirty = true;
  lastChangeAt = Date.now();
  console.log(`[crystal-controller] Dirty: ${reason}`);
}

export function startController() {
  const config = getConfig();
  const updateConfig = config.update || {};

  const debounceMs = (updateConfig.debounceMinutes || 5) * 60 * 1000;
  const checkMs = (updateConfig.checkIntervalSeconds || 60) * 1000;
  const safetyMs = (updateConfig.safetyCronHours || 6) * 60 * 60 * 1000;

  console.log(`[crystal-controller] Started: debounce=${updateConfig.debounceMinutes || 5}m, check=${updateConfig.checkIntervalSeconds || 60}s, safety=${updateConfig.safetyCronHours || 6}h`);

  intervalId = setInterval(async () => {
    if (isGenerating) return;

    const now = Date.now();
    const debounced = crystalDirty && (now - lastChangeAt) >= debounceMs;
    const safety = (now - lastGeneration) >= safetyMs;

    if (debounced || safety) {
      isGenerating = true;
      const reason = debounced ? 'debounced change' : 'safety cron';
      console.log(`[crystal-controller] Regenerating Crystal (${reason})`);

      try {
        await generateCrystal();
        crystalDirty = false;
        lastGeneration = Date.now();
        console.log(`[crystal-controller] Crystal regenerated successfully`);
      } catch(e) {
        console.error(`[crystal-controller] Generation failed: ${e.message}`);
      } finally {
        isGenerating = false;
      }
    }
  }, checkMs);
}

export function stopController() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[crystal-controller] Stopped');
  }
}

export function getStatus() {
  return {
    dirty: crystalDirty,
    lastChangeAt: lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
    lastGeneration: new Date(lastGeneration).toISOString(),
    isGenerating,
    running: intervalId !== null
  };
}
