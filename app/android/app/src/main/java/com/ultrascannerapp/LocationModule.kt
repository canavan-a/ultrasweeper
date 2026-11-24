package com.ultrascannerapp

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Phone location for hunts (see src/location.ts for the JS half).
 *
 * Plain android.location.LocationManager, not Play Services' fused provider:
 * no extra dependency, and it works on de-Googled phones. GPS is the fix we
 * want for tagging sightings; the network provider (when the phone has one)
 * only fills in until GPS locks. Permission is requested from JS
 * (PermissionsAndroid); this module just refuses to start without it.
 *
 * Updates keep coming with the app in the background as long as the
 * foreground service runs with the "location" type (src/background.ts).
 */
class LocationModule(private val reactCtx: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactCtx) {

  override fun getName() = "PhoneLocation"

  private var listening = false
  private var lastGpsAt = 0L

  private val listener =
      object : LocationListener {
        override fun onLocationChanged(loc: Location) {
          if (loc.provider == LocationManager.GPS_PROVIDER) {
            lastGpsAt = loc.time
          } else if (loc.time - lastGpsAt < NETWORK_GRACE_MS) {
            // A recent GPS fix beats a cell/wifi estimate.
            return
          }
          emit(loc)
        }

        // Required overrides below API 30 (abstract there); no-ops here.
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

        override fun onProviderEnabled(provider: String) {}

        override fun onProviderDisabled(provider: String) {}
      }

  private companion object {
    const val NETWORK_GRACE_MS = 15_000L
  }

  private fun manager() = reactCtx.getSystemService(Context.LOCATION_SERVICE) as LocationManager

  private fun hasPermission(): Boolean =
      reactCtx.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
          PackageManager.PERMISSION_GRANTED ||
          reactCtx.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
              PackageManager.PERMISSION_GRANTED

  private fun toMap(loc: Location): WritableMap {
    val m = Arguments.createMap()
    m.putDouble("lat", loc.latitude)
    m.putDouble("lon", loc.longitude)
    m.putDouble("t", loc.time.toDouble())
    m.putString("provider", loc.provider ?: "")
    if (loc.hasAccuracy()) m.putDouble("acc", loc.accuracy.toDouble())
    if (loc.hasAltitude()) m.putDouble("alt", loc.altitude)
    if (loc.hasSpeed()) m.putDouble("speed", loc.speed.toDouble())
    if (loc.hasBearing()) m.putDouble("heading", loc.bearing.toDouble())
    return m
  }

  private fun emit(loc: Location) {
    if (!reactCtx.hasActiveReactInstance()) return
    reactCtx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("PhoneLocation", toMap(loc))
  }

  /** Start updates every ~intervalMs. Resolves false when not permitted. */
  @SuppressLint("MissingPermission")
  @ReactMethod
  fun start(intervalMs: Double, promise: Promise) {
    if (!hasPermission()) {
      promise.resolve(false)
      return
    }
    val lm = manager()
    stopUpdates()
    var any = false
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      try {
        if (!lm.allProviders.contains(provider)) continue
        lm.requestLocationUpdates(provider, intervalMs.toLong(), 0f, listener, Looper.getMainLooper())
        any = true
        lm.getLastKnownLocation(provider)?.let { emit(it) }
      } catch (_: Exception) {
        // provider absent / disabled on this phone — try the next one
      }
    }
    listening = any
    promise.resolve(any)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopUpdates()
    promise.resolve(null)
  }

  /** Whether any location provider is switched on in system settings. */
  @ReactMethod
  fun isEnabled(promise: Promise) {
    val lm = manager()
    val on =
        try {
          lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
              lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
          false
        }
    promise.resolve(on)
  }

  private fun stopUpdates() {
    if (!listening) return
    listening = false
    try {
      manager().removeUpdates(listener)
    } catch (_: Exception) {}
  }

  // Needed for NativeEventEmitter on the JS side.
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onCatalystInstanceDestroy() {
    stopUpdates()
    super.onCatalystInstanceDestroy()
  }
}
