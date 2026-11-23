package app.namu.onnxtts

import java.io.File
import java.security.MessageDigest
import kotlin.concurrent.thread

fun sha(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }

fun main(args: Array<String>) {
  val dir = File(args[0]).apply { deleteRecursively(); mkdirs() }
  val base = "https://raw.githubusercontent.com/SmaxsupeR/namu-voices/e7986d0e3cafec044c7bb176ffbc9b886e77673f/packs/int8w/"
  // 1. Small file.
  val lic = File(dir, "LICENSE")
  println("small: ${Downloader.download(base + "LICENSE", lic, 15007) { _, _ -> }} bytes, sha ${sha(lic).take(12)}")
  // 2. Large file, cancelled midway, then resumed.
  val big = File(dir, "onnx/vector_estimator.onnx")
  val expected = File(args[1]).length()
  var progressCalls = 0
  val t = thread { Thread.sleep(2500); Downloader.cancelled = true }
  try {
    Downloader.download(base + "onnx/vector_estimator.onnx", big, expected) { _, _ -> progressCalls++ }
    println("not cancelled?")
  } catch (e: InterruptedException) {
    println("cancelled at ${big.length()} of $expected bytes, progress events $progressCalls")
  }
  t.join()
  val before = big.length()
  val got = Downloader.download(base + "onnx/vector_estimator.onnx", big, expected) { _, _ -> }
  println("resumed from $before to $got, sha matches: ${sha(big) == sha(File(args[1]))}")
  // 3. Complete file is not downloaded again.
  val t0 = System.nanoTime()
  Downloader.download(base + "onnx/vector_estimator.onnx", big, expected) { _, _ -> }
  println("already complete: ${(System.nanoTime() - t0) / 1_000_000} ms")
  // 4. Hugging Face redirects to its CDN on another host.
  val tts = File(dir, "tts.json")
  Downloader.download("https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/onnx/tts.json", tts, 8253) { _, _ -> }
  println("hf tts.json sha ${sha(tts).take(12)} (expect 42078d3aef1c)")
  val vs = File(dir, "F1.json")
  Downloader.download("https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/voice_styles/F1.json", vs, 292046) { _, _ -> }
  println("hf F1.json sha ${sha(vs).take(12)} (expect bbdec6ee0023)")
  // 5. Errors: missing file and a bad URL.
  try { Downloader.download(base + "nope.bin", File(dir, "nope"), -1) { _, _ -> } } catch (e: Downloader.HttpError) { println("missing -> ${e.message}") }
  try { Downloader.download("0LICENSE", File(dir, "x"), -1) { _, _ -> } } catch (e: IllegalArgumentException) { println("bad url -> ${e.message}") }
}
