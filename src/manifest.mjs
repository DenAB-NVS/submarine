/**
 * Manifest — current submarine state descriptor.
 *
 * Static JSON; update_channel reserved for future use.
 *
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getConfig, getSubmarinePath } from './config.mjs';

export function getManifest() {
  const config = getConfig();
  const base = getSubmarinePath();

  let version = '0.1.0';
  try {
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf-8'));
    version = pkg.version || version;
  } catch(e) { /* default */ }

  const rings = [];
  if (config.rings?.soul?.enabled !== false) rings.push('soul');
  if (config.rings?.knowledge?.enabled !== false) rings.push('knowledge');
  if (config.rings?.causality?.enabled !== false) rings.push('causality');

  const extensionsDir = join(base, config.paths?.extensions || 'extensions');
  let extensions = [];
  try {
    if (existsSync(extensionsDir)) {
      extensions = readdirSync(extensionsDir)
        .filter(f => f.endsWith('.mjs') && !f.startsWith('.'))
        .map(f => f.replace('.mjs', ''));
    }
  } catch(e) { /* empty */ }

  return {
    block: 1,
    version,
    rings,
    extensions,
    update_channel: config.manifest?.updateChannel || null,
    generated: new Date().toISOString()
  };
}
