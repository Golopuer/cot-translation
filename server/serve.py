"""cot-translate-local: 本地翻译服务（仅翻译模块）。

加载 Qwen3.5-0.8B 一次，提供：
  - / (GET)         翻译网页
  - /health (GET)   健康检查
  - /v1/translate   POST {"text": "..."} → {"ok": true, "text": "中文概括"}

启动（用装了 torch+transformers 的 python）：
    python serve.py
"""
import json
import os
import sys
import time
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

MODEL_DIR = os.environ.get("QWEN_LOCAL_MODEL_DIR", "./models/Qwen3.5-0.8B")
HOST = os.environ.get("QWEN_LOCAL_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_LOCAL_PORT", "7860"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

_state = {
    "model": None,
    "tokenizer": None,
    "device": None,
    "lock": threading.Lock(),
    "load_error": None,
    "loaded_at": None,
}

# 模型推理串行信号：所有生成共用一个模型，必须串行，否则 GPU 并发会卡死。
_model_idle = threading.Event()
_model_idle.set()

TRANSLATE_SYSTEM = (
    "把下面这段英文思考过程概括成 1-2 句简洁的中文，说人话。"
    "必须准确翻译否定词和限定词：not/never/without 翻成「不」，only/just 翻成「只/仅」，"
    "例如 does NOT mirror 必须翻成「不镜像」，绝不能漏掉否定。"
    "代码、文件路径、命令、变量名、工具名保持英文原样。"
    "只输出中文概括本身，不要输出原文，不要加解释。"
)


def load():
    """Load model + tokenizer exactly once (thread-safe)."""
    with _state["lock"]:
        if _state["model"] is not None or _state["load_error"] is not None:
            return
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            device = "cuda" if torch.cuda.is_available() else "cpu"
            tok = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=False)
            model = AutoModelForCausalLM.from_pretrained(
                MODEL_DIR,
                dtype=torch.bfloat16,
                low_cpu_mem_usage=True,
            ).to(device)
            model.eval()
            _state.update(model=model, tokenizer=tok, device=device, loaded_at=time.time())
            print(f"[cot-translate] loaded on {device}", flush=True)
        except Exception as e:  # noqa: BLE001
            _state["load_error"] = traceback.format_exc()
            print(f"[cot-translate] LOAD FAILED: {e}", file=sys.stderr, flush=True)


def _ensure_loaded():
    if _state["load_error"] is not None:
        raise RuntimeError(_state["load_error"])
    if _state["model"] is None:
        raise RuntimeError("模型尚未加载完成，请稍等几秒再试")


def _generate(messages, system, max_new_tokens=512, temperature=0.7, top_p=0.9,
              do_sample=True, repetition_penalty=1.0):
    """核心生成函数：所有采样参数可从外部传入，便于充分调控模型。"""
    _ensure_loaded()
    tok = _state["tokenizer"]
    model = _state["model"]
    device = _state["device"]

    full = []
    if system:
        full.append({"role": "system", "content": system})
    full.extend(messages)

    prompt = tok.apply_chat_template(full, tokenize=False, add_generation_prompt=True)
    ids = tok(prompt, return_tensors="pt").to(device)

    gen_kwargs = {
        "max_new_tokens": int(max_new_tokens),
        "repetition_penalty": float(repetition_penalty),
    }
    if do_sample:
        gen_kwargs.update({
            "do_sample": True,
            "temperature": float(temperature),
            "top_p": float(top_p),
        })
    else:
        gen_kwargs.update({
            "do_sample": False,
            "temperature": None,
            "top_p": None,
        })

    t0 = time.time()
    _model_idle.wait()
    _model_idle.clear()
    try:
        with torch.inference_mode():
            out = model.generate(**ids, **gen_kwargs)
    finally:
        _model_idle.set()
    reply_ids = out[0][ids["input_ids"].shape[1]:]
    text = tok.decode(reply_ids, skip_special_tokens=True).strip()
    elapsed = round(time.time() - t0, 2)
    num_tokens = int(reply_ids.numel())
    return {"text": text, "elapsed_s": elapsed, "output_tokens": num_tokens}


def translate(text):
    _ensure_loaded()
    return _generate(
        [{"role": "user", "content": text}],
        system=TRANSLATE_SYSTEM,
        max_new_tokens=256,
        do_sample=False,
    )["text"]


class Handler(BaseHTTPRequestHandler):
    server_version = "cot-translate/1.0"

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        if not os.path.exists(path):
            self._send_json(404, {"error": "not found"})
            return
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send_file(os.path.join(BASE_DIR, "index.html"), "text/html; charset=utf-8")
        elif path == "/health":
            self._send_json(200, {
                "ok": _state["model"] is not None,
                "device": _state["device"],
                "loaded_at": _state["loaded_at"],
                "load_error": _state["load_error"],
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/v1/translate":
            body = self._read_body()
            text = (body.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "text is required"})
                return
            try:
                zh = translate(text)
                self._send_json(200, {"ok": True, "text": zh})
            except Exception as e:  # noqa: BLE001
                self._send_json(500, {"ok": False, "error": str(e)})
        else:
            self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # quieter logs
        pass


def main():
    threading.Thread(target=load, daemon=True).start()
    print(f"[cot-translate] serving http://{HOST}:{PORT}  (model: {MODEL_DIR})", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
