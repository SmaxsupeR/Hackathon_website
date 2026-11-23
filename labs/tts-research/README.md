# Исследование TTS (этап C)

Скрипты, которыми получены результаты в [docs/tts-research.md](../../docs/tts-research.md). Модель и аудио в репозиторий не входят.

```bash
python3 -m venv .venv && .venv/bin/pip install supertonic onnx onnxconverter-common faster-whisper librosa soundfile
# скачать Supertone/supertonic-3 (commit 3cadd1e) в ./model
.venv/bin/python quantize.py model variants          # FP32-копия, INT8 динамическое квантование
.venv/bin/python weightonly.py variants/fp32 variants # хранение весов в FP16 / INT8
.venv/bin/python bench.py variants/int8w out/int8w F1 8 4
.venv/bin/python quality.py out large-v3-turbo fp32-F1-s8 int8w-F1-s8
.venv/bin/python make_pack.py variants/int8w int8w "INT8, сжатые веса" namu-voice-int8w.zip
```

`DownloaderCheck.kt` — проверка загрузчика голосовых пакетов на JVM: скачивание, обрыв и докачка, переадресация Hugging Face, ошибки.

`KotlinEngineCheck.kt` — запуск движка лаборатории (`labs/tts-lab/modules/onnx-tts/.../SupertonicEngine.kt`) на обычной JVM с настольным ONNX Runtime, чтобы проверить перенос без телефона.
