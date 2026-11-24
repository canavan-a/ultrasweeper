package com.ultrascannerapp

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.PowerManager
import android.os.Process
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * USB serial bridge to the scanner board (see src/usb.ts for the JS half).
 * The scanner is a dumb box that writes PROTOCOL.md lines on its USB serial
 * at SCANNER_BAUD; usb-serial-for-android handles the CP210x/CH340/FTDI/CDC
 * chip on the devkit. This module only moves bytes: parsing happens in
 * src/protocol.ts, and data flows one way (device -> phone), so there is no
 * write() — the firmware is configured by its build flags, not by commands.
 */
class UsbSerialModule(private val reactCtx: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactCtx) {

  override fun getName() = "UsbSerial"

  private companion object {
    const val ACTION_PERMISSION = "com.ultrascannerapp.UsbSerial.PERMISSION"
    // 16 KiB per USB request: the most Android allows for one bulk IN
    // request on every API level we support.
    const val READ_BUF = 16 * 1024
    const val FLUSH_MS = 50L
    // ~11 s of a saturated 921600-baud line.
    const val MAX_PENDING = 1024 * 1024
  }

  private var port: UsbSerialPort? = null
  private var ioManager: SerialInputOutputManager? = null
  private var flusher: ScheduledExecutorService? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private val reading = AtomicBoolean(false)
  private val pendingLock = Any()
  private val pending = ByteArrayOutputStream(64 * 1024)
  private var droppedBytes = 0L

  // Hot-plug: tells JS to re-run getDeviceList() (and to drop the live
  // connection if the open device is the one that went away).
  private val hotplugReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          val map = Arguments.createMap()
          map.putString("state", if (intent.action == UsbManager.ACTION_USB_DEVICE_DETACHED) "detached" else "attached")
          intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)?.let {
            map.putString("deviceId", it.deviceName)
          }
          sendEvent("UsbSerialState", map)
        }
      }

  override fun initialize() {
    val filter =
        IntentFilter().apply {
          addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
          addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
    reactCtx.registerReceiver(hotplugReceiver, filter)
  }

  // RN 0.75 has no dispose() on ReactContextBaseJavaModule; this is the
  // hook legacy modules still get (same one @react-native-async-storage
  // uses). Unregister first so a JS reload can't leak receivers.
  @Suppress("OVERRIDE_DEPRECATION")
  override fun onCatalystInstanceDestroy() {
    try {
      reactCtx.unregisterReceiver(hotplugReceiver)
    } catch (_: Exception) {}
    closePort()
    super.onCatalystInstanceDestroy()
  }

  private fun sendEvent(name: String, payload: com.facebook.react.bridge.WritableMap) {
    if (reactCtx.hasActiveReactInstance()) {
      reactCtx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(name, payload)
    }
  }

  private fun allDrivers(): List<UsbSerialDriver> {
    val um = reactCtx.getSystemService(Context.USB_SERVICE) as UsbManager
    return UsbSerialProber.getDefaultProber().findAllDrivers(um)
  }

  @ReactMethod
  fun getDeviceList(promise: Promise) {
    try {
      val list = Arguments.createArray()
      for (d in allDrivers()) {
        val m = Arguments.createMap()
        // deviceName (e.g. /dev/bus/usb/001/002) is what open() keys on and
        // what the DETACHED broadcast carries, so hot-plug can match it.
        m.putString("deviceId", d.device.deviceName)
        // UsbSerialDriver has no name of its own; label the entry from the
        // USB descriptors, falling back to VID:PID when the chip has none
        // (bare CH340 clones do not).
        m.putString(
            "productName",
            d.device.productName
                ?: "%s %04x:%04x".format(
                    d.device.manufacturerName ?: "USB serial",
                    d.device.vendorId,
                    d.device.productId))
        m.putInt("vendorId", d.device.vendorId)
        m.putInt("productId", d.device.productId)
        list.pushMap(m)
      }
      promise.resolve(list)
    } catch (e: Exception) {
      promise.reject("usb_list_failed", e)
    }
  }

  @ReactMethod
  fun open(deviceId: String, baud: Int, promise: Promise) {
    val driver = allDrivers().firstOrNull { it.device.deviceName == deviceId }
    if (driver == null) {
      promise.reject("no_such_device", "device not present or has no known serial driver")
      return
    }
    val um = reactCtx.getSystemService(Context.USB_SERVICE) as UsbManager
    if (!um.hasPermission(driver.device)) {
      requestPermissionAndOpen(um, driver, baud, promise)
      return
    }
    doOpen(driver, baud, promise)
  }

  private fun requestPermissionAndOpen(
      um: UsbManager, driver: UsbSerialDriver, baud: Int, promise: Promise) {
    val pi =
        PendingIntent.getBroadcast(
            reactCtx,
            driver.device.deviceId,
            Intent(ACTION_PERMISSION).setPackage(reactCtx.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val receiver =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context, intent: Intent) {
            try {
              reactCtx.unregisterReceiver(this)
            } catch (_: Exception) {}
            if (!um.hasPermission(driver.device)) {
              promise.reject("permission_denied", "USB permission was not granted")
            } else {
              doOpen(driver, baud, promise)
            }
          }
        }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
      reactCtx.registerReceiver(
          receiver, IntentFilter(ACTION_PERMISSION), Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      reactCtx.registerReceiver(receiver, IntentFilter(ACTION_PERMISSION))
    }
    um.requestPermission(driver.device, pi)
  }

  private fun doOpen(driver: UsbSerialDriver, baud: Int, promise: Promise) {
    closePort()
    // open() takes a UsbDeviceConnection, obtained from the UsbManager;
    // the port closes that connection again in close().
    val um = reactCtx.getSystemService(Context.USB_SERVICE) as UsbManager
    val connection = um.openDevice(driver.device)
    if (connection == null) {
      promise.reject("open_failed", "could not open a USB connection to ${driver.device.deviceName}")
      return
    }
    val p = driver.ports[0]
    try {
      p.open(connection)
      p.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
      // Keep DTR/RTS low: the auto-reset circuit on ESP32 devkits reacts to
      // those lines, and the app must not reboot (or boot-loop) the scanner
      // just by connecting to it.
      try {
        p.setDTR(false)
        p.setRTS(false)
      } catch (_: IOException) {}
      port = p
    } catch (e: Exception) {
      try {
        connection.close()
      } catch (_: Exception) {}
      promise.reject("open_failed", e)
      return
    }

    val deviceId = driver.device.deviceName
    // Keep the CPU awake while the port is open, so reads (and the JS scan
    // session's police alerts, see src/background.ts) keep going with the
    // screen off. Held from open to close.
    val pm = reactCtx.getSystemService(Context.POWER_SERVICE) as PowerManager
    val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ultrascanner:usb-read")
    wl.acquire()
    wakeLock = wl

    // Reading: the library's SerialInputOutputManager with a read timeout of
    // 0. That path keeps a UsbRequest queued and blocks in requestWait().
    // A read *with* a timeout (what this module used to do, 250 ms) goes
    // through bulkTransfer(), which usb-serial-for-android documents as
    // losing data at high baud rates with continuous traffic. At 921600
    // that loss showed up as merged/garbled lines and a stalling app.
    //
    // onNewData only appends to `pending`, so the USB thread is back in
    // requestWait() fast (the bridge chip's FIFO is tiny). A separate
    // flusher hands the bytes to JS at most every FLUSH_MS, so a busy
    // stream costs JS ~20 events a second, not one per USB packet.
    val io =
        SerialInputOutputManager(
            p,
            object : SerialInputOutputManager.Listener {
              override fun onNewData(data: ByteArray) {
                synchronized(pendingLock) {
                  if (pending.size() + data.size > MAX_PENDING) {
                    // JS has stopped draining. Drop the backlog rather than
                    // grow without bound; the parser resyncs on the next line.
                    droppedBytes += pending.size()
                    pending.reset()
                  }
                  pending.write(data, 0, data.size)
                }
              }

              override fun onRunError(e: Exception) {
                // Also fires when close() stops the manager; only report
                // errors while we still mean to be reading.
                if (!reading.getAndSet(false)) return
                flush(deviceId)
                val m = Arguments.createMap()
                m.putString("deviceId", deviceId)
                m.putString("state", "error")
                m.putString("message", e.message ?: "read error")
                sendEvent("UsbSerialState", m)
              }
            })
    io.readTimeout = 0
    io.readBufferSize = READ_BUF
    io.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    synchronized(pendingLock) {
      pending.reset()
      droppedBytes = 0
    }
    reading.set(true)
    ioManager = io
    io.start()

    val exec = Executors.newSingleThreadScheduledExecutor()
    exec.scheduleWithFixedDelay({ flush(deviceId) }, FLUSH_MS, FLUSH_MS, TimeUnit.MILLISECONDS)
    flusher = exec
    promise.resolve(null)
  }

  /** Hand everything read since the last flush to JS as one event. */
  private fun flush(deviceId: String) {
    val bytes: ByteArray
    val dropped: Long
    synchronized(pendingLock) {
      if (pending.size() == 0) return
      bytes = pending.toByteArray()
      pending.reset()
      dropped = droppedBytes
    }
    val map = Arguments.createMap()
    map.putString("deviceId", deviceId)
    // Base64 rather than a String: even though every PROTOCOL.md byte is
    // ASCII, a chunk boundary must never matter to JS.
    map.putString("data64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    // cumulative bytes discarded because JS fell behind (normally 0)
    map.putDouble("dropped", dropped.toDouble())
    sendEvent("UsbSerialData", map)
  }

  @ReactMethod
  fun close(promise: Promise) {
    closePort()
    promise.resolve(null)
  }

  private fun closePort() {
    reading.set(false)
    flusher?.shutdownNow()
    flusher = null
    // stop() asks the IO thread to finish; closing the port cancels its
    // pending UsbRequest so requestWait() returns.
    ioManager?.stop()
    ioManager = null
    port?.let {
      try {
        it.close()
      } catch (_: IOException) {}
    }
    port = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }
}
