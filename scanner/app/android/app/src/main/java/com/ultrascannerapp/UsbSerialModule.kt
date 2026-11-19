package com.ultrascannerapp

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
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
import java.io.IOException
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
    const val READ_BUF = 1024
    const val READ_TIMEOUT_MS = 250
  }

  private var port: UsbSerialPort? = null
  private var reader: Thread? = null
  private var reading = AtomicBoolean(false)

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

    reading.set(true)
    val deviceId = driver.device.deviceName
    reader =
        Thread {
          val buf = ByteArray(READ_BUF)
          var err: String? = null
          while (reading.get()) {
            val n =
                try {
                  p.read(buf, READ_TIMEOUT_MS)
                } catch (e: IOException) {
                  // A read timeout is normal silence (the scanner batches, so
                  // there are gaps); only a real error ends the thread.
                  if (e.message?.contains("timeout") == true) continue
                  err = e.message ?: "read error"
                  break
                }
            if (n > 0) {
              val map = Arguments.createMap()
              map.putString("deviceId", deviceId)
              // Base64 rather than a String: even though every PROTOCOL.md
              // byte is ASCII, a chunk boundary must never matter to JS.
              map.putString(
                  "data64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP))
              sendEvent("UsbSerialData", map)
            }
          }
          val m = Arguments.createMap()
          m.putString("deviceId", deviceId)
          m.putString("state", if (err == null) "closed" else "error")
          err?.let { m.putString("message", it) }
          sendEvent("UsbSerialState", m)
        }
    reader?.start()
    promise.resolve(null)
  }

  @ReactMethod
  fun close(promise: Promise) {
    closePort()
    promise.resolve(null)
  }

  private fun closePort() {
    reading.set(false)
    reader?.let {
      try {
        it.join(1000)
      } catch (_: InterruptedException) {}
    }
    reader = null
    port?.let {
      try {
        it.close()
      } catch (_: IOException) {}
    }
    port = null
  }
}
