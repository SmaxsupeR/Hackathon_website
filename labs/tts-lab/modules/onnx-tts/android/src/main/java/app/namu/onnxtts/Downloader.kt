package app.namu.onnxtts

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads one file over HTTPS with resume: if part of the file is already on disk, only
 * the rest is requested (HTTP Range). Plain Java APIs, so it is tested on a desktop JVM too.
 */
object Downloader {
  class HttpError(val status: Int, url: String) : Exception("HTTP $status for $url")

  @Volatile var cancelled = false

  /**
   * @param expectedSize known size of the file, or -1. A complete file is not downloaded again.
   * @param onProgress called with (bytes on disk, total bytes) at most every 100 ms.
   * @return bytes on disk when finished.
   */
  fun download(url: String, dest: File, expectedSize: Long, onProgress: (Long, Long) -> Unit): Long {
    require(url.startsWith("https://") || url.startsWith("http://")) { "Not an http(s) URL: '$url'" }
    cancelled = false
    dest.parentFile?.mkdirs()
    var have = if (dest.exists()) dest.length() else 0L
    if (expectedSize >= 0 && have > expectedSize) {
      dest.delete()
      have = 0
    }
    if (expectedSize >= 0 && have == expectedSize) return have

    var current = URL(url)
    var conn: HttpURLConnection
    var redirects = 0
    while (true) {
      conn = (current.openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 20_000
        readTimeout = 60_000
        setRequestProperty("User-Agent", "NamuTtsLab/0.1")
        if (have > 0) setRequestProperty("Range", "bytes=$have-")
      }
      val code = conn.responseCode
      if (code in 300..399 && redirects < 5) {
        // Follow redirects ourselves: Java does not follow them across hosts by default (Hugging Face uses a CDN).
        val location = conn.getHeaderField("Location") ?: throw HttpError(code, url)
        conn.disconnect()
        current = URL(current, location)
        redirects++
        continue
      }
      if (code == 416 && expectedSize >= 0 && have == expectedSize) return have
      if (code !in 200..299) {
        conn.disconnect()
        throw HttpError(code, url)
      }
      break
    }
    val append = conn.responseCode == 206
    if (!append) have = 0
    val total = if (expectedSize >= 0) expectedSize else have + conn.contentLengthLong
    var last = 0L
    try {
      FileOutputStream(dest, append).use { out ->
        conn.inputStream.use { input ->
          val buf = ByteArray(1 shl 16)
          while (true) {
            if (cancelled) throw InterruptedException("Download cancelled")
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            have += n
            val now = System.currentTimeMillis()
            if (now - last >= 100) {
              last = now
              onProgress(have, total)
            }
          }
        }
      }
    } finally {
      conn.disconnect()
    }
    onProgress(have, total)
    return have
  }
}
