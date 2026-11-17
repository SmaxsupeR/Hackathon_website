package app.namu.onnxtts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer
import java.text.Normalizer
import java.util.Random

/** Voice style vectors read from a voice style JSON file (voice_styles folder). */
class VoiceStyle(val ttl: FloatArray, val ttlShape: LongArray, val dp: FloatArray, val dpShape: LongArray)

/** Timings of one synthesis, in milliseconds. */
data class SynthResult(
  val audio: FloatArray,
  val sampleRate: Int,
  val dpMs: Double,
  val encoderMs: Double,
  val flowMs: Double,
  val vocoderMs: Double,
  val totalMs: Double,
)

/**
 * Supertonic 3 text-to-speech on ONNX Runtime, ported from the official Python SDK
 * (supertonic 1.3.1, core.py): text → duration → text encoder → flow-matching steps → vocoder.
 * Everything runs locally from model files on the device.
 */
class SupertonicEngine(dir: File, threads: Int, foldWeights: Boolean) : AutoCloseable {
  private val env = OrtEnvironment.getEnvironment()
  private val dp: OrtSession
  private val encoder: OrtSession
  private val flow: OrtSession
  private val vocoder: OrtSession
  private val indexer: IntArray
  val sampleRate: Int
  private val chunkSize: Int
  private val latentDim: Int

  init {
    val onnx = File(dir, "onnx")
    val parts = listOf("duration_predictor", "text_encoder", "vector_estimator", "vocoder")
    for (p in parts) {
      val f = File(onnx, "$p.onnx")
      if (!f.exists()) throw ModelFileMissing(f.name)
    }
    for (name in listOf("tts.json", "unicode_indexer.json")) {
      if (!File(onnx, name).exists()) throw ModelFileMissing(name)
    }
    val cfg = JSONObject(File(onnx, "tts.json").readText())
    sampleRate = cfg.getJSONObject("ae").getInt("sample_rate")
    val compress = cfg.getJSONObject("ttl").getInt("chunk_compress_factor")
    chunkSize = cfg.getJSONObject("ae").getInt("base_chunk_size") * compress
    latentDim = cfg.getJSONObject("ttl").getInt("latent_dim") * compress
    val idx = JSONArray(File(onnx, "unicode_indexer.json").readText())
    indexer = IntArray(idx.length()) { idx.getInt(it) }

    val opts = OrtSession.SessionOptions().apply {
      setIntraOpNumThreads(threads)
      setInterOpNumThreads(1)
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      // Weight-only quantized models: expand weights to float32 once at load (faster, more memory).
      if (foldWeights) addConfigEntry("session.disable_quant_qdq", "1")
    }
    val opened = mutableListOf<OrtSession>()
    try {
      for (p in parts) opened += env.createSession(File(onnx, "$p.onnx").absolutePath, opts)
    } catch (e: Throwable) {
      opened.forEach { it.close() }
      throw e
    }
    dp = opened[0]; encoder = opened[1]; flow = opened[2]; vocoder = opened[3]
  }

  fun loadStyle(file: File): VoiceStyle {
    if (!file.exists()) throw ModelFileMissing(file.name)
    val j = JSONObject(file.readText())
    fun part(key: String): Pair<FloatArray, LongArray> {
      val o = j.getJSONObject(key)
      val dims = o.getJSONArray("dims")
      val shape = LongArray(dims.length()) { dims.getLong(it) }
      val out = FloatArray(shape.fold(1L) { a, b -> a * b }.toInt())
      var n = 0
      fun walk(a: Any) {
        if (a is JSONArray) for (i in 0 until a.length()) walk(a.get(i)) else out[n++] = (a as Number).toFloat()
      }
      walk(o.getJSONArray("data"))
      return out to shape
    }
    val (ttl, ttlShape) = part("style_ttl")
    val (dpv, dpShape) = part("style_dp")
    return VoiceStyle(ttl, ttlShape, dpv, dpShape)
  }

  fun synth(text: String, style: VoiceStyle, steps: Int, speed: Double, seed: Long): SynthResult {
    val t0 = System.nanoTime()
    val ids = textIds(preprocess(text))
    val len = ids.size.toLong()
    val textIds = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), longArrayOf(1, len))
    val textMask = OnnxTensor.createTensor(env, FloatBuffer.wrap(FloatArray(ids.size) { 1f }), longArrayOf(1, 1, len))
    val styleDp = OnnxTensor.createTensor(env, FloatBuffer.wrap(style.dp), style.dpShape)
    val styleTtl = OnnxTensor.createTensor(env, FloatBuffer.wrap(style.ttl), style.ttlShape)
    val opened = mutableListOf<AutoCloseable>(textIds, textMask, styleDp, styleTtl)
    try {
      val durOut = dp.run(mapOf("text_ids" to textIds, "style_dp" to styleDp, "text_mask" to textMask))
      opened += durOut
      val duration = (durOut.get(0) as OnnxTensor).floatBuffer.get(0) / speed
      val t1 = System.nanoTime()
      val encOut = encoder.run(mapOf("text_ids" to textIds, "style_ttl" to styleTtl, "text_mask" to textMask))
      opened += encOut
      val textEmb = encOut.get(0) as OnnxTensor
      val t2 = System.nanoTime()

      val wavLen = (duration * sampleRate).toLong()
      val latentLen = ((wavLen + chunkSize - 1) / chunkSize).toInt().coerceAtLeast(1)
      val rnd = Random(seed)
      val noise = FloatArray(latentDim * latentLen) { rnd.nextGaussian().toFloat() }
      var xt = OnnxTensor.createTensor(env, FloatBuffer.wrap(noise), longArrayOf(1, latentDim.toLong(), latentLen.toLong()))
      val latentMask = OnnxTensor.createTensor(env, FloatBuffer.wrap(FloatArray(latentLen) { 1f }), longArrayOf(1, 1, latentLen.toLong()))
      val total = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(steps.toFloat())), longArrayOf(1))
      opened += latentMask; opened += total
      var prev: OrtSession.Result? = null
      for (s in 0 until steps) {
        val current = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(s.toFloat())), longArrayOf(1))
        val r = flow.run(
          mapOf(
            "noisy_latent" to xt, "text_emb" to textEmb, "style_ttl" to styleTtl, "text_mask" to textMask,
            "latent_mask" to latentMask, "current_step" to current, "total_step" to total,
          ),
        )
        current.close()
        if (prev == null) xt.close() else prev.close()
        prev = r
        xt = r.get(0) as OnnxTensor
      }
      val t3 = System.nanoTime()
      val vocOut = vocoder.run(mapOf("latent" to xt))
      opened += vocOut
      prev?.close() ?: xt.close()
      val buf = (vocOut.get(0) as OnnxTensor).floatBuffer
      val n = minOf(wavLen.toInt(), buf.remaining())
      val audio = FloatArray(n)
      buf.get(audio, 0, n)
      val t4 = System.nanoTime()
      return SynthResult(audio, sampleRate, ms(t0, t1), ms(t1, t2), ms(t2, t3), ms(t3, t4), ms(t0, t4))
    } finally {
      opened.forEach { runCatching { it.close() } }
    }
  }

  private fun ms(a: Long, b: Long) = (b - a) / 1e6

  private fun textIds(text: String): LongArray {
    val cps = text.codePoints().toArray()
    return LongArray(cps.size) { i -> if (cps[i] < indexer.size) indexer[cps[i]].toLong() else -1L }
  }

  override fun close() {
    listOf(dp, encoder, flow, vocoder).forEach { runCatching { it.close() } }
  }

  companion object {
    private val EMOJI = Regex("[\\x{1F600}-\\x{1F64F}\\x{1F300}-\\x{1F5FF}\\x{1F680}-\\x{1F6FF}\\x{1F700}-\\x{1F77F}\\x{1F780}-\\x{1F7FF}\\x{1F800}-\\x{1F8FF}\\x{1F900}-\\x{1F9FF}\\x{1FA00}-\\x{1FA6F}\\x{1FA70}-\\x{1FAFF}\\x{2600}-\\x{26FF}\\x{2700}-\\x{27BF}\\x{1F1E6}-\\x{1F1FF}]+")
    private val SYMBOLS = listOf(
      "–" to "-", "‑" to "-", "—" to "-", "¯" to " ", "_" to " ", "“" to "\"", "”" to "\"",
      "‘" to "'", "’" to "'", "´" to "'", "`" to "'", "[" to " ", "]" to " ", "|" to " ", "/" to " ", "#" to " ",
      "→" to " ", "←" to " ",
    )
    private val SPECIAL = Regex("[♥☆♡©\\\\]")
    private val SPACING = listOf(" ," to ",", " ." to ".", " !" to "!", " ?" to "?", " ;" to ";", " :" to ":", " '" to "'")
    private val QUOTES = Regex("([\"'`])\\1+")
    private val SPACE = Regex("\\s+")
    private val ENDING = Regex("[.!?;:,'\"')\\]}…。」』】〉》›»]$")

    /** Same steps as UnicodeProcessor._preprocess_text in the Python SDK, for Korean. */
    fun preprocess(raw: String): String {
      var t = Normalizer.normalize(raw, Normalizer.Form.NFKD)
      t = EMOJI.replace(t, "")
      for ((a, b) in SYMBOLS) t = t.replace(a, b)
      t = SPECIAL.replace(t, "")
      t = t.replace("@", " at ").replace("e.g.,", "for example, ").replace("i.e.,", "that is, ")
      for ((a, b) in SPACING) t = t.replace(a, b)
      t = QUOTES.replace(t, "$1")
      t = SPACE.replace(t, " ").trim()
      if (!ENDING.containsMatchIn(t)) t += "."
      return "<ko>$t</ko>"
    }
  }
}
