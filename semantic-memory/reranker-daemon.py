#!/usr/bin/env python3
"""
BGE Reranker + Sparse Embedding Daemon
=======================================
HTTP server on port 3200 serving:
  - BAAI/bge-reranker-v2-m3 (cross-encoder reranking)
  - BAAI/bge-m3 (sparse lexical weights for hybrid retrieval)

Endpoints:
  POST /rerank  — {query, documents, top_n} → {results: [{index, score}]}
  POST /sparse  — {texts: [...]}            → {weights: [{token: weight, ...}, ...]}
  GET  /health  — {status, reranker, sparse_model, models_loaded}

Idle timeout: models are unloaded after 5 minutes of inactivity to free RAM/CPU.
"""

import gc
import json
import sys
import time
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

IDLE_TIMEOUT = 0  # disabled — models stay loaded permanently (4GB on 28GB machine is fine)

# Global model state
_reranker = None
_sparse_model = None
_last_activity = time.time()
_models_loaded = False
_load_lock = threading.Lock()


def _load_models():
    """Load both models into memory."""
    global _reranker, _sparse_model, _models_loaded, _last_activity
    with _load_lock:
        if _models_loaded:
            _last_activity = time.time()
            return
        print("Loading BAAI/bge-reranker-v2-m3 ...", flush=True)
        from FlagEmbedding import FlagReranker
        _reranker = FlagReranker('BAAI/bge-reranker-v2-m3', use_fp16=False)
        print("Reranker model loaded.", flush=True)

        print("Loading BAAI/bge-m3 for sparse retrieval ...", flush=True)
        from FlagEmbedding import BGEM3FlagModel
        _sparse_model = BGEM3FlagModel('BAAI/bge-m3', use_fp16=False)
        print("BGE-M3 sparse model loaded.", flush=True)

        _models_loaded = True
        _last_activity = time.time()


def _unload_models():
    """Unload models to free memory."""
    global _reranker, _sparse_model, _models_loaded
    with _load_lock:
        if not _models_loaded:
            return
        print("Idle timeout reached. Unloading models...", flush=True)
        del _reranker
        del _sparse_model
        _reranker = None
        _sparse_model = None
        _models_loaded = False
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        print("Models unloaded. Memory freed.", flush=True)


def _ensure_models():
    """Ensure models are loaded, loading them lazily if needed."""
    global _last_activity
    if not _models_loaded:
        _load_models()
    _last_activity = time.time()


def _idle_watchdog():
    """Background thread that unloads models after IDLE_TIMEOUT seconds of inactivity."""
    if IDLE_TIMEOUT <= 0:
        return  # disabled — models stay loaded permanently
    while True:
        time.sleep(30)  # check every 30 seconds
        if _models_loaded and (time.time() - _last_activity > IDLE_TIMEOUT):
            _unload_models()


def extract_sparse_weights(model, texts):
    """
    Encode texts and return sparse lexical weights as list of {token: weight} dicts.
    Uses BGE-M3's built-in sparse (lexical) retrieval mode.
    """
    output = model.encode(texts, return_sparse=True)
    lexical_weights = output['lexical_weights']
    tokenizer = model.tokenizer

    results = []
    for weights_dict in lexical_weights:
        token_weights = {}
        for token_id, weight in weights_dict.items():
            token_str = tokenizer.decode([int(token_id)]).strip()
            if token_str and len(token_str) > 1:  # skip single-char noise
                token_weights[token_str] = round(float(weight), 4)
        results.append(token_weights)
    return results


class RerankerHandler(BaseHTTPRequestHandler):
    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_POST(self):
        try:
            if self.path == '/health':
                # Health does NOT trigger model loading
                self._send_json(200, {
                    "status": "ok",
                    "reranker": "BAAI/bge-reranker-v2-m3",
                    "sparse_model": "BAAI/bge-m3",
                    "models_loaded": _models_loaded,
                    "idle_seconds": round(time.time() - _last_activity, 1)
                })
                return

            if self.path == '/rerank':
                data = self._read_body()
                query = data.get('query', '')
                documents = data.get('documents', [])
                top_n = data.get('top_n', len(documents))

                if not query or not documents:
                    self._send_json(400, {"error": "query and documents required"})
                    return

                _ensure_models()

                pairs = [[query, doc] for doc in documents]
                scores = _reranker.compute_score(pairs, normalize=True)

                # compute_score returns a single float when len(pairs)==1
                if isinstance(scores, (int, float)):
                    scores = [scores]

                indexed = [{"index": i, "score": float(s)} for i, s in enumerate(scores)]
                indexed.sort(key=lambda x: x["score"], reverse=True)
                indexed = indexed[:top_n]

                self._send_json(200, {"results": indexed})
                return

            if self.path == '/sparse':
                data = self._read_body()
                texts = data.get('texts', [])

                if not texts:
                    self._send_json(400, {"error": "texts array required"})
                    return

                _ensure_models()

                weights = extract_sparse_weights(_sparse_model, texts)
                self._send_json(200, {"weights": weights})
                return

            self._send_json(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {"error": str(e)})

    def do_GET(self):
        if self.path == '/health':
            # Health does NOT trigger model loading
            self._send_json(200, {
                "status": "ok",
                "reranker": "BAAI/bge-reranker-v2-m3",
                "sparse_model": "BAAI/bge-m3",
                "models_loaded": _models_loaded,
                "idle_seconds": round(time.time() - _last_activity, 1)
            })
        else:
            self._send_json(404, {"error": "not found"})

    # Suppress per-request logging
    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    # Load models eagerly on first start (so first request isn't slow)
    _load_models()

    # Start idle watchdog thread
    watchdog = threading.Thread(target=_idle_watchdog, daemon=True)
    watchdog.start()

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadingHTTPServer(('127.0.0.1', 3200), RerankerHandler)
    print("Reranker+Sparse daemon listening on 127.0.0.1:3200 (idle timeout: 5min)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
