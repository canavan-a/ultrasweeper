package com.ultrascannerapp

import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter

/**
 * Local hunt logs (src/huntlog.ts is the JS half): one CSV file per scanner
 * connection, kept in the app's private storage under files/hunts/.
 * Nothing leaves the phone unless the user shares or saves a file.
 *
 * JS batches rows and calls append() every couple of seconds, so a busy
 * scan costs one bridge call and one small write per batch, not per row.
 */
class HuntLogModule(private val reactCtx: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactCtx) {

  override fun getName() = "HuntLog"

  private var writer: BufferedWriter? = null
  private var openName: String? = null

  private fun dir(): File = File(reactCtx.filesDir, "hunts").apply { mkdirs() }

  /** Only plain file names we created: no paths, no surprises. */
  private fun file(name: String): File {
    require(Regex("^[A-Za-z0-9._-]+\\.csv$").matches(name)) { "bad log name: $name" }
    return File(dir(), name)
  }

  @ReactMethod
  fun open(name: String, header: String, promise: Promise) {
    try {
      closeWriter()
      val f = file(name)
      val fresh = !f.exists() || f.length() == 0L
      val w = BufferedWriter(OutputStreamWriter(FileOutputStream(f, true), Charsets.UTF_8))
      if (fresh) w.write(header)
      w.flush()
      writer = w
      openName = name
      promise.resolve(f.length().toDouble())
    } catch (e: Exception) {
      promise.reject("log_open_failed", e)
    }
  }

  /** Append text to the open log; resolves to the file's new size. */
  @ReactMethod
  fun append(text: String, promise: Promise) {
    val w = writer
    val name = openName
    if (w == null || name == null) {
      promise.reject("log_not_open", "no log is open")
      return
    }
    try {
      w.write(text)
      // Flush every batch: a killed app then loses at most one batch.
      w.flush()
      promise.resolve(file(name).length().toDouble())
    } catch (e: Exception) {
      promise.reject("log_write_failed", e)
    }
  }

  @ReactMethod
  fun close(promise: Promise) {
    closeWriter()
    promise.resolve(null)
  }

  private fun closeWriter() {
    try {
      writer?.close()
    } catch (_: Exception) {}
    writer = null
    openName = null
  }

  @ReactMethod
  fun list(promise: Promise) {
    try {
      val out = Arguments.createArray()
      dir()
          .listFiles { f -> f.isFile && f.name.endsWith(".csv") }
          ?.sortedByDescending { it.lastModified() }
          ?.forEach { f ->
            val m = Arguments.createMap()
            m.putString("name", f.name)
            m.putDouble("size", f.length().toDouble())
            m.putDouble("modified", f.lastModified().toDouble())
            m.putBoolean("open", f.name == openName)
            out.pushMap(m)
          }
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("log_list_failed", e)
    }
  }

  @ReactMethod
  fun remove(name: String, promise: Promise) {
    try {
      if (name == openName) closeWriter()
      promise.resolve(file(name).delete())
    } catch (e: Exception) {
      promise.reject("log_delete_failed", e)
    }
  }

  /** Android share sheet (Drive, email, Files, Signal, …) for one log. */
  @ReactMethod
  fun share(name: String, promise: Promise) {
    try {
      writer?.flush()
      val f = file(name)
      // Same FileProvider the updater uses; res/xml/file_paths.xml maps hunts/.
      val uri = FileProvider.getUriForFile(reactCtx, reactCtx.packageName + ".updateprovider", f)
      val send =
          Intent(Intent.ACTION_SEND).apply {
            type = "text/csv"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, f.name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
      val chooser =
          Intent.createChooser(send, f.name).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
      reactCtx.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("log_share_failed", e)
    }
  }

  /** Copy a log into the public Downloads folder (Android 10+, no permission needed). */
  @ReactMethod
  fun saveToDownloads(name: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.reject("log_save_unsupported", "Saving to Downloads needs Android 10+; use Share instead.")
      return
    }
    try {
      writer?.flush()
      val f = file(name)
      val values =
          ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, f.name)
            put(MediaStore.Downloads.MIME_TYPE, "text/csv")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ultrasweeper")
          }
      val resolver = reactCtx.contentResolver
      val uri =
          resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
              ?: throw IllegalStateException("could not create the Downloads entry")
      resolver.openOutputStream(uri).use { out ->
        requireNotNull(out) { "could not open the Downloads entry" }
        f.inputStream().use { it.copyTo(out) }
      }
      promise.resolve("Download/ultrasweeper/${f.name}")
    } catch (e: Exception) {
      promise.reject("log_save_failed", e)
    }
  }

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onCatalystInstanceDestroy() {
    closeWriter()
    super.onCatalystInstanceDestroy()
  }
}
