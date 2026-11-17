package app.namu.onnxtts

import org.json.JSONArray
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

class ModelFileMissing(name: String) : Exception("missing $name")

fun writeWav(f: File, audio: FloatArray, rate: Int) {
  val data = ByteBuffer.allocate(audio.size * 2).order(ByteOrder.LITTLE_ENDIAN)
  for (x in audio) data.putShort((x.coerceIn(-1f, 1f) * 32767).toInt().toShort())
  RandomAccessFile(f, "rw").use { raf ->
    raf.setLength(0)
    val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    h.put("RIFF".toByteArray()).putInt(36 + audio.size * 2).put("WAVE".toByteArray()).put("fmt ".toByteArray())
      .putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
      .put("data".toByteArray()).putInt(audio.size * 2)
    raf.write(h.array()); raf.write(data.array())
  }
}

/** args: modelDir outDir testSet.json foldWeights */
fun main(args: Array<String>) {
  val t0 = System.nanoTime()
  val engine = SupertonicEngine(File(args[0]), 4, args[3] == "1")
  println("load ms ${(System.nanoTime() - t0) / 1e6}")
  val style = engine.loadStyle(File(args[0], "voice_styles/F1.json"))
  val tests = JSONArray(File(args[2]).readText())
  File(args[1]).mkdirs()
  var synth = 0.0
  var audio = 0.0
  for (i in 0 until tests.length()) {
    val t = tests.getJSONObject(i)
    val r = engine.synth(t.getString("text"), style, 8, 1.0, 1000L + i)
    writeWav(File(args[1], t.getString("id") + ".wav"), r.audio, r.sampleRate)
    synth += r.totalMs; audio += r.audio.size.toDouble() / r.sampleRate
  }
  println("rtf ${synth / 1000 / audio}")
  println("preprocess: " + SupertonicEngine.preprocess("밥 먹었어요?") + " | " + SupertonicEngine.preprocess("  “신라” — 2026년  "))
  engine.close()
}
