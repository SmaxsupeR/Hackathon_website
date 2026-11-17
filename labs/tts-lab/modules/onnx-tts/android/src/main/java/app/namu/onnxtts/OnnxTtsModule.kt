package app.namu.onnxtts

import android.app.ActivityManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Debug
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.zip.ZipInputStream

class ModelFileMissing(name: String) : CodedException("E_MISSING_FILE", "Model file is missing: $name", null)
class ModelNotLoaded : CodedException("E_NOT_LOADED", "No model is loaded", null)
class ModelLoadFailed(cause: Throwable) : CodedException("E_LOAD_FAILED", "Model could not be loaded: ${cause.message}", cause)
class OutOfMemory(cause: Throwable) : CodedException("E_OUT_OF_MEMORY", "Not enough memory: ${cause.message}", cause)
class SynthFailed(cause: Throwable) : CodedException("E_SYNTH_FAILED", "Synthesis failed: ${cause.message}", cause)

/** Experimental local TTS module for the TTS lab: Supertonic 3 on ONNX Runtime, with measurements. */
class OnnxTtsModule : Module() {
  private var engine: SupertonicEngine? = null
  private var modelDir: File? = null
  private val styles = mutableMapOf<String, VoiceStyle>()
  private var track: AudioTrack? = null

  private fun path(p: String) = File(p.removePrefix("file://"))

  private fun memory(): Map<String, Any?> {
    var rss = 0.0
    var peak = 0.0
    runCatching {
      File("/proc/self/status").forEachLine { line ->
        if (line.startsWith("VmRSS:")) rss = line.split(Regex("\\s+"))[1].toDouble() / 1024
        if (line.startsWith("VmHWM:")) peak = line.split(Regex("\\s+"))[1].toDouble() / 1024
      }
    }
    return mapOf("rssMb" to rss, "peakMb" to peak, "nativeHeapMb" to Debug.getNativeHeapAllocatedSize() / 1048576.0)
  }

  /** Resets the peak-memory counter of this process, so each test measures its own peak. */
  private fun resetPeak(): Boolean = runCatching { File("/proc/self/clear_refs").writeText("5") }.isSuccess

  override fun definition() = ModuleDefinition {
    Name("OnnxTts")

    AsyncFunction("deviceInfo") {
      val ctx = appContext.reactContext
      val am = ctx?.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      val mi = ActivityManager.MemoryInfo().also { am?.getMemoryInfo(it) }
      mapOf(
        "manufacturer" to Build.MANUFACTURER, "model" to Build.MODEL, "android" to Build.VERSION.RELEASE, "sdk" to Build.VERSION.SDK_INT,
        "soc" to (if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE),
        "abis" to Build.SUPPORTED_ABIS.joinToString(), "cores" to Runtime.getRuntime().availableProcessors(),
        "totalRamMb" to mi.totalMem / 1048576.0, "availRamMb" to mi.availMem / 1048576.0, "lowRamDevice" to (am?.isLowRamDevice ?: false),
        "ortVersion" to "1.32.0",
      )
    }

    AsyncFunction("memory") { memory() }

    AsyncFunction("sha256") { file: String ->
      val f = path(file)
      if (!f.exists()) throw ModelFileMissing(f.name)
      val md = MessageDigest.getInstance("SHA-256")
      f.inputStream().use { input ->
        val buf = ByteArray(1 shl 20)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          md.update(buf, 0, n)
        }
      }
      md.digest().joinToString("") { "%02x".format(it) }
    }

    AsyncFunction("unzip") { zip: String, dest: String ->
      val out = path(dest).apply { mkdirs() }
      var count = 0
      ZipInputStream(path(zip).inputStream().buffered()).use { zin ->
        while (true) {
          val e = zin.nextEntry ?: break
          val target = File(out, e.name).canonicalFile
          if (!target.path.startsWith(out.canonicalPath)) throw CodedException("E_BAD_ZIP", "Unsafe path in archive: ${e.name}", null)
          if (e.isDirectory) target.mkdirs() else {
            target.parentFile?.mkdirs()
            FileOutputStream(target).use { zin.copyTo(it, 1 shl 20) }
            count++
          }
        }
      }
      count
    }

    AsyncFunction("load") { dir: String, threads: Int, foldWeights: Boolean ->
      engine?.close(); engine = null; styles.clear(); System.gc()
      val before = memory()
      val peakReset = resetPeak()
      val t0 = System.nanoTime()
      try {
        engine = SupertonicEngine(path(dir), threads, foldWeights)
        modelDir = path(dir)
      } catch (e: CodedException) {
        throw e
      } catch (e: OutOfMemoryError) {
        throw OutOfMemory(e)
      } catch (e: Throwable) {
        throw ModelLoadFailed(e)
      }
      mapOf("loadMs" to (System.nanoTime() - t0) / 1e6, "before" to before, "after" to memory(), "peakReset" to peakReset)
    }

    AsyncFunction("synth") { text: String, voice: String, steps: Int, speed: Double, seed: Double, play: Boolean ->
      val e = engine ?: throw ModelNotLoaded()
      val style = styles.getOrPut(voice) { e.loadStyle(File(modelDir, "voice_styles/$voice.json")) }
      val r = try {
        e.synth(text, style, steps, speed, seed.toLong())
      } catch (err: OutOfMemoryError) {
        throw OutOfMemory(err)
      } catch (err: CodedException) {
        throw err
      } catch (err: Throwable) {
        throw SynthFailed(err)
      }
      var firstSoundMs: Double? = null
      if (play) firstSoundMs = playAndWaitForSound(r.audio, r.sampleRate)
      mapOf(
        "dpMs" to r.dpMs, "encoderMs" to r.encoderMs, "flowMs" to r.flowMs, "vocoderMs" to r.vocoderMs, "totalMs" to r.totalMs,
        "audioSec" to r.audio.size.toDouble() / r.sampleRate, "playbackStartMs" to firstSoundMs, "memory" to memory(),
      )
    }

    AsyncFunction("synthToFile") { text: String, voice: String, steps: Int, speed: Double, seed: Double, out: String ->
      val e = engine ?: throw ModelNotLoaded()
      val style = styles.getOrPut(voice) { e.loadStyle(File(modelDir, "voice_styles/$voice.json")) }
      val r = e.synth(text, style, steps, speed, seed.toLong())
      writeWav(path(out), r.audio, r.sampleRate)
      r.audio.size.toDouble() / r.sampleRate
    }

    AsyncFunction("release") {
      engine?.close(); engine = null; styles.clear(); modelDir = null
      track?.release(); track = null
      System.gc()
      Thread.sleep(300)
      memory()
    }

    OnDestroy {
      engine?.close(); engine = null
      track?.release(); track = null
    }
  }

  /** Plays the samples and returns the time from the play call until the first frame was played. */
  private fun playAndWaitForSound(audio: FloatArray, rate: Int): Double {
    track?.release()
    val t = AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
      .setTransferMode(AudioTrack.MODE_STATIC)
      .setBufferSizeInBytes(maxOf(audio.size * 4, 4096))
      .build()
    t.write(audio, 0, audio.size, AudioTrack.WRITE_BLOCKING)
    track = t
    val start = System.nanoTime()
    t.play()
    while (t.playbackHeadPosition == 0 && System.nanoTime() - start < 2_000_000_000L) Thread.sleep(1)
    return (System.nanoTime() - start) / 1e6
  }

  private fun writeWav(f: File, audio: FloatArray, rate: Int) {
    f.parentFile?.mkdirs()
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
}
