package com.ultrascannerapp

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.UUID

/**
 * GATT probe (src/gatt.ts, ScanScreen device rows): borrow the phone's
 * own BLE central for a few seconds — scan for the MAC, connect, walk the
 * GATT table, read what's readable without pairing, report, disconnect.
 *
 * Why the phone and not the nRF24 rig: the nRF24 only eavesdrops on ads;
 * holding a connection needs a real BLE link layer, which the phone has.
 *
 * Deliberately conservative: never pairs (would write to the device's
 * bond store), never writes (a read can't change anything the device
 * owns), one probe at a time, and everything is torn down on every
 * exit path. Known no-permission/no-radio failures reject with fixed
 * codes so the UI can explain instead of guessing.
 */
class GattProbeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "GattProbe"

    private val handler = Handler(Looper.getMainLooper())
    private var inFlight = false

    // Fixed budgets: the whole probe must fail closed, drive-by style.
    private val scanBudgetMs = 5_000L
    private val connectBudgetMs = 5_000L
    private val readBudgetMs = 5_000L
    private val maxReads = 24

    @ReactMethod
    fun probe(mac: String, promise: Promise) {
        if (inFlight) {
            promise.reject("busy", "a probe is already running")
            return
        }
        val manager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            promise.reject("no-bluetooth", "Bluetooth is off or this phone has no BLE")
            return
        }
        if (!haveNearbyPermissions()) {
            promise.reject("no-permission", "grant the Nearby devices permission first")
            return
        }
        val target = mac.uppercase()
        if (!Regex("^([0-9A-F]{2}:){5}[0-9A-F]{2}$").matches(target)) {
            promise.reject("bad-mac", "not a MAC address")
            return
        }

        inFlight = true
        val session = ProbeState(target, promise)
        session.finish = {
            inFlight = false
        }
        startScan(adapter, session)
    }

    private fun haveNearbyPermissions(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Pre-12 BLE rides on the location permission, which hunts hold.
            return true
        }
        for (p in arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)) {
            if (reactContext.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false
        }
        return true
    }

    // One probe's mutable state + the single finish() path that resolves.
    private inner class ProbeState(
        val target: String,
        val promise: Promise,
    ) {
        var gatt: BluetoothGatt? = null
        var stopScan: () -> Unit = {}
        var readQueue: List<BluetoothGattCharacteristic> = emptyList()
        var readIndex = 0
        val services = Arguments.createArray()
        // live references to each characteristic entry, so a finished read
        // can fill in valueHex even after the entry is in `services`
        val charsByUuid = HashMap<String, com.facebook.react.bridge.WritableMap>()
        var settled = false
        var finish: () -> Unit = {}

        fun arm(budgetMs: Long, failure: String) {
            // one phase timer at a time: the previous phase's timer must not
            // outlive the phase it was watching
            handler.removeCallbacksAndMessages(null)
            handler.postDelayed({ settle(failure) }, budgetMs)
        }

        fun settle(status: String, detail: String? = null) {
            if (settled) return
            settled = true
            handler.removeCallbacksAndMessages(null)
            // every exit path stops the radio: a not-found probe must not
            // leave a LE scan running for the rest of the hunt
            try {
                stopScan()
            } catch (_: SecurityException) {
            }
            try {
                gatt?.close()
            } catch (_: SecurityException) {
                // permission vanished mid-probe; nothing to close cleanly
            }
            // Once the service tree is walked, a late read timeout is still
            // a useful answer: return what came back and say it stopped.
            val resolved = status == "ok" || (status == "read-timeout" && services.size() > 0)
            if (resolved) {
                val map = Arguments.createMap()
                map.putString("address", target)
                map.putArray("services", services)
                if (status != "ok") map.putString("truncated", status)
                promise.resolve(map)
            } else {
                promise.reject(status, detail ?: status)
            }
            finish()
        }
    }

    private fun startScan(adapter: BluetoothAdapter, s: ProbeState) {
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            s.settle("no-bluetooth", "BLE scanner unavailable")
            return
        }
        val callback = object : ScanCallback() {
            override fun onScanResult(type: Int, result: ScanResult) {
                val device = result.device ?: return
                if (device.address != s.target) return
                try {
                    scanner.stopScan(this)
                } catch (_: SecurityException) {
                }
                connect(device, s)
            }

            override fun onScanFailed(errorCode: Int) {
                s.settle("scan-failed", "scan error $errorCode")
            }
        }
        try {
            // No filter: SP6-class devices rotate/randomize addresses and
            // ScanFilter only matches the printed one anyway; match in the
            // callback like the hunt pipeline already does.
            scanner.startScan(
                null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                callback,
            )
        } catch (_: SecurityException) {
            s.settle("no-permission")
            return
        }
        s.stopScan = { scanner.stopScan(callback) }
        s.arm(scanBudgetMs, "not-found")
    }

    private fun connect(device: BluetoothDevice, s: ProbeState) {
        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                // take the object either way so settle() closes it, even when
                // the very first state event is a refusal
                val fresh = s.gatt == null
                s.gatt = gatt
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try {
                        gatt.discoverServices()
                    } catch (_: SecurityException) {
                        s.settle("no-permission")
                    }
                } else if (fresh) {
                    s.settle("connect-refused", "device refused the connection")
                }
                // Drops after discovery already resolved or are covered by the budget.
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    s.settle("discover-failed", "status $status")
                    return
                }
                queueReads(gatt, s)
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                ch: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) {
                recordRead(s, ch, value)
                readNext(gatt, s)
            }

            // API < 26 path routes through here; both reach the same record.
            @Deprecated("legacy GATT API")
            override fun onCharacteristicRead(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
                @Suppress("DEPRECATION")
                recordRead(s, ch, ch.value ?: ByteArray(0))
                readNext(gatt, s)
            }
        }
        try {
            // direct=false: connect through the stack, never pair.
            device.connectGatt(reactContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        } catch (_: SecurityException) {
            s.settle("no-permission")
            return
        }
        s.arm(connectBudgetMs, "connect-timeout")
    }

    private fun queueReads(gatt: BluetoothGatt, s: ProbeState) {
        for (svc in gatt.services) {
            val map = Arguments.createMap()
            map.putString("uuid", svc.uuid.toString())
            val chars = Arguments.createArray()
            for (ch in svc.characteristics) {
                val cm = Arguments.createArray()
                if (ch.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) cm.pushString("read")
                if (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) cm.pushString("write")
                if (ch.properties and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) {
                    cm.pushString("notify")
                }
                if (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) cm.pushString("writeNoResponse")
                val cm2 = Arguments.createMap()
                cm2.putString("uuid", ch.uuid.toString())
                cm2.putArray("properties", cm)
                chars.pushMap(cm2)
                s.charsByUuid[svc.uuid.toString() + "|" + ch.uuid.toString()] = cm2
                if (ch.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
                    s.readQueue += ch
                }
            }
            map.putArray("characteristics", chars)
            s.services.pushMap(map)
        }
        // Device Information first: the identity labels are what a probe is
        // for, and the read budget should buy those before anything else.
        val deviceInfo = UUID.fromString("0000180a-0000-1000-8000-00805f9b34fb")
        s.readQueue = s.readQueue.sortedBy {
            if (it.service?.uuid == deviceInfo) 0 else 1
        }
        s.readQueue = s.readQueue.take(maxReads)
        s.arm(readBudgetMs, "read-timeout")
        readNext(gatt, s)
    }

    private fun readNext(gatt: BluetoothGatt, s: ProbeState) {
        if (s.settled) return
        if (s.readIndex >= s.readQueue.size) {
            s.settle("ok")
            return
        }
        val ch = s.readQueue[s.readIndex++]
        try {
            if (!gatt.readCharacteristic(ch)) {
                readNext(gatt, s) // busy or gone: skip, keep the budget
            }
        } catch (_: SecurityException) {
            s.settle("no-permission")
        }
    }

    private fun recordRead(s: ProbeState, ch: BluetoothGattCharacteristic, value: ByteArray) {
        val key = ch.service?.uuid.toString() + "|" + ch.uuid
        val cm = s.charsByUuid[key] ?: return
        // a second read of the same characteristic (shouldn't happen: the
        // queue is built once) must not overwrite the first value
        if (cm.hasKey("valueHex")) return
        cm.putString("valueHex", value.joinToString("") { b -> "%02X".format(b) })
    }
}
