import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'submarine.config.json');

let _config = null;

export function getConfig() {
    if (!_config) {
        _config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
    return _config;
}

export function getServerPort() {
    return getConfig().server?.defaultPort || 3100;
}

export function getOllamaUrl() {
    return getConfig().ollama?.url || 'http://localhost:11434';
}

export function getOllamaModel() {
    return getConfig().ollama?.model || getConfig().embedding?.model || 'bge-m3';
}

export function getEmbedDim() {
    return getConfig().ollama?.dimensions || getConfig().embedding?.dim || 1024;
}

export function getApiKey() {
    return process.env.SUBMARINE_API_KEY || '';
}

export function getWorkspacePath() {
    return join(__dirname, '..');
}

export function getSubmarinePath() {
    return join(__dirname, '..');
}
