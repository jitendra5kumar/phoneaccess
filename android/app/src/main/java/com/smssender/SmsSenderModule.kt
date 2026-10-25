package com.SmsSender

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.SmsManager
import android.content.pm.PackageManager
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SmsSenderModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val SEND_STATUS_TIMEOUT_MS = 20_000L
    }

    private data class DirectSmsSendResult(
        val payload: com.facebook.react.bridge.WritableMap? = null,
        val error: String? = null,
    )

    override fun getName(): String = "SmsSenderModule"

    @ReactMethod
    fun sendSms(recipient: String?, message: String?, promise: Promise) {
        val number = recipient?.trim().orEmpty()
        val text = message?.trim().orEmpty()

        if (number.isEmpty() || text.isEmpty()) {
            promise.reject("E_INVALID_ARGS", "recipient and message are required")
            return
        }

        // SEND_SMS is declared in AndroidManifest.xml.
        // SmsManager throws SecurityException itself if permission is truly missing.
        try {
            val directResult = trySendDirectSms(number, text)
            if (directResult.payload != null) {
                promise.resolve(directResult.payload)
                return
            }

            throw IllegalStateException(directResult.error ?: "SMS send failed without explicit error.")
        } catch (error: SecurityException) {
            promise.reject("E_SEND_SMS_PERMISSION", "SEND_SMS permission not granted at runtime.")
        } catch (error: Throwable) {
            promise.reject("E_SEND_SMS_FAILED", error.message ?: error.toString())
        }
    }

    @ReactMethod
    fun openRcsComposer(recipient: String?, message: String?, promise: Promise) {
        val number = recipient?.trim().orEmpty()
        val text = message?.trim().orEmpty()

        if (number.isEmpty() || text.isEmpty()) {
            promise.reject("E_INVALID_ARGS", "recipient and message are required")
            return
        }

        val googleMessagesPackage = "com.google.android.apps.messaging"
        val hasGoogleMessages = isPackageInstalled(googleMessagesPackage)

        try {
            val directResult = trySendDirectSms(number, text)
            if (directResult.payload != null) {
                promise.resolve(directResult.payload)
                return
            }

            CallRecordingAccessibilityService.enqueueRcsSend(text)

            val composerIntents = buildComposerIntents(number, text, googleMessagesPackage, hasGoogleMessages)
            val launchIntent = composerIntents.firstOrNull { intent ->
                intent.resolveActivity(reactContext.packageManager) != null
            }

            if (launchIntent != null) {
                reactContext.startActivity(launchIntent)
                promise.resolve(true)
                return
            }

            CallRecordingAccessibilityService.clearPendingRcsSend()
            val fallbackError = directResult.error ?: "Direct SMS failed and no composer is available."
            promise.reject("E_RCS_COMPOSER_UNAVAILABLE", fallbackError)
        } catch (error: Throwable) {
            CallRecordingAccessibilityService.clearPendingRcsSend()
            promise.reject("E_RCS_COMPOSER_FAILED", error.message ?: error.toString())
        }
    }

    @ReactMethod
    fun openWhatsAppComposer(recipient: String?, message: String?, promise: Promise) {
        val number = recipient?.trim().orEmpty()
        val text = message?.trim().orEmpty()

        if (number.isEmpty() || text.isEmpty()) {
            promise.reject("E_INVALID_ARGS", "recipient and message are required")
            return
        }

        val normalizedPhone = number.filter { it.isDigit() }
        if (normalizedPhone.isEmpty()) {
            promise.reject("E_INVALID_RECIPIENT", "recipient must contain at least one digit")
            return
        }

        val packageCandidates = listOf("com.whatsapp", "com.whatsapp.w4b")
        val targetPackage = packageCandidates.firstOrNull { isPackageInstalled(it) }
        if (targetPackage == null) {
            promise.reject("E_WHATSAPP_MISSING", "WhatsApp app is not installed on this device.")
            return
        }

        try {
            CallRecordingAccessibilityService.enqueueWhatsAppSend(text)

            val uriCandidates = listOf(
                Uri.parse("whatsapp://send?phone=$normalizedPhone&text=${Uri.encode(text)}"),
                Uri.parse("https://wa.me/$normalizedPhone?text=${Uri.encode(text)}"),
            )

            val launchIntent = uriCandidates
                .asSequence()
                .map { uri ->
                    Intent(Intent.ACTION_VIEW, uri).apply {
                        setPackage(targetPackage)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                }
                .firstOrNull { intent -> intent.resolveActivity(reactContext.packageManager) != null }

            if (launchIntent == null) {
                CallRecordingAccessibilityService.clearPendingWhatsAppSend()
                promise.reject("E_WHATSAPP_COMPOSER_UNAVAILABLE", "WhatsApp compose intent is unavailable.")
                return
            }

            reactContext.startActivity(launchIntent)
            promise.resolve(true)
        } catch (error: Throwable) {
            CallRecordingAccessibilityService.clearPendingWhatsAppSend()
            promise.reject("E_WHATSAPP_COMPOSER_FAILED", error.message ?: error.toString())
        }
    }

    private fun buildComposerIntents(
        number: String,
        text: String,
        googleMessagesPackage: String,
        hasGoogleMessages: Boolean,
    ): List<Intent> {
        val baseAddress = number.trim().replace(" ", "")

        val sendToIntent = Intent(Intent.ACTION_SENDTO).apply {
            data = Uri.parse("smsto:$baseAddress")
            putExtra("address", baseAddress)
            putExtra("sms_body", text)
            putExtra("android.intent.extra.TEXT", text)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
            data = Uri.parse("sms:$baseAddress")
            putExtra("address", baseAddress)
            putExtra("sms_body", text)
            putExtra("android.intent.extra.TEXT", text)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        return listOfNotNull(
            sendToIntent.takeIf { hasGoogleMessages }.apply {
                this?.setPackage(googleMessagesPackage)
            },
            sendToIntent,
            viewIntent,
        )
    }

    private fun trySendDirectSms(number: String, text: String): DirectSmsSendResult {
        val smsManagers = resolveSmsManagers()
        val candidates = buildNumberCandidates(number)
        var lastError: String? = null

        for ((subscriptionId, smsManager) in smsManagers) {
            for (candidate in candidates) {
                try {
                    val sendStatusError = sendMultipartWithStatus(smsManager, candidate, text)
                    if (sendStatusError != null) {
                        lastError = "sub=$subscriptionId, recipient=$candidate -> $sendStatusError"
                        continue
                    }

                    val result = Arguments.createMap().apply {
                        putBoolean("ok", true)
                        putString("recipient", candidate)
                        putInt("subscriptionId", subscriptionId)
                    }
                    return DirectSmsSendResult(payload = result)
                } catch (securityError: SecurityException) {
                    throw securityError
                } catch (sendError: Throwable) {
                    val context = "sub=$subscriptionId, recipient=$candidate"
                    lastError = "$context -> ${sendError.message ?: sendError::class.java.simpleName}"
                }
            }
        }

        return if (lastError != null) {
            DirectSmsSendResult(error = lastError)
        } else {
            DirectSmsSendResult(error = "Unable to send SMS directly on this device.")
        }
    }

    private fun sendMultipartWithStatus(smsManager: SmsManager, recipient: String, text: String): String? {
        val parts = smsManager.divideMessage(text)
        if (parts.isEmpty()) {
            return "Message body is empty after processing."
        }

        val action = "com.SmsSender.SMS_SENT_STATUS.${UUID.randomUUID()}"
        val filter = IntentFilter(action)
        val latch = CountDownLatch(parts.size)
        val receivedCount = AtomicInteger(0)
        val failureReason = AtomicReference<String?>(null)

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val resultCode = resultCode
                receivedCount.incrementAndGet()

                if (resultCode != Activity.RESULT_OK && failureReason.get() == null) {
                    failureReason.set(mapSmsResultCode(resultCode))
                }

                latch.countDown()
            }
        }

        registerSmsStatusReceiver(receiver, filter)

        try {
            val sentIntents = ArrayList<PendingIntent?>(parts.size)
            val pendingFlags =
                PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

            repeat(parts.size) { index ->
                val sentIntent = Intent(action).apply {
                    setPackage(reactContext.packageName)
                    putExtra("partIndex", index)
                }

                val requestCode = (System.currentTimeMillis().toInt() and 0x7FFFFFFF) + index
                sentIntents.add(
                    PendingIntent.getBroadcast(
                        reactContext,
                        requestCode,
                        sentIntent,
                        pendingFlags,
                    ),
                )
            }

            smsManager.sendMultipartTextMessage(recipient, null, parts, sentIntents, null)

            val completed = latch.await(SEND_STATUS_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            if (!completed) {
                return "Timed out waiting for SMS send confirmation."
            }

            val failed = failureReason.get()
            if (failed != null) {
                return failed
            }

            if (receivedCount.get() < parts.size) {
                return "Only partial SMS send callbacks were received."
            }

            return null
        } finally {
            try {
                reactContext.unregisterReceiver(receiver)
            } catch (_: Throwable) {
            }
        }
    }

    private fun registerSmsStatusReceiver(receiver: BroadcastReceiver, filter: IntentFilter) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            reactContext.registerReceiver(receiver, filter)
        }
    }

    private fun mapSmsResultCode(resultCode: Int): String {
        return when (resultCode) {
            Activity.RESULT_OK -> "Message sent"
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic SMS failure from carrier"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "No cellular service for SMS"
            SmsManager.RESULT_ERROR_NULL_PDU -> "Invalid SMS payload"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio is off"
            SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "SMS limit exceeded on device or SIM"
            SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE -> "FDN check failed for recipient"
            else -> "SMS failed with result code $resultCode"
        }
    }

    private fun buildNumberCandidates(number: String): List<String> {
        val clean = number.trim()
        if (clean.isEmpty()) {
            return emptyList()
        }

        val candidates = mutableListOf(clean)
        if (!clean.startsWith("+") && clean.length >= 11 && clean.length <= 15) {
            candidates.add("+$clean")
        }
        return candidates.distinct()
    }

    @Suppress("DEPRECATION")
    private fun resolveSmsManagers(): List<Pair<Int, SmsManager>> {
        val pairs = mutableListOf<Pair<Int, SmsManager>>()
        val subIds = linkedSetOf<Int>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val invalid = SubscriptionManager.INVALID_SUBSCRIPTION_ID
            val defaultSms = SubscriptionManager.getDefaultSmsSubscriptionId()
            if (defaultSms != invalid) {
                subIds.add(defaultSms)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val defaultData = SubscriptionManager.getDefaultDataSubscriptionId()
                if (defaultData != invalid) {
                    subIds.add(defaultData)
                }
                val defaultVoice = SubscriptionManager.getDefaultVoiceSubscriptionId()
                if (defaultVoice != invalid) {
                    subIds.add(defaultVoice)
                }
            }

            val subscriptionManager = reactContext.getSystemService(SubscriptionManager::class.java)
            val activeSubs = subscriptionManager?.activeSubscriptionInfoList.orEmpty()
            activeSubs.forEach { subInfo ->
                subIds.add(subInfo.subscriptionId)
            }

            subIds.forEach { subId ->
                pairs.add(subId to SmsManager.getSmsManagerForSubscriptionId(subId))
            }
        }

        // Final fallback for older devices or when no active subscription is discovered.
        if (pairs.isEmpty()) {
            pairs.add(-1 to SmsManager.getDefault())
        }

        return pairs
    }

    private fun isPackageInstalled(packageName: String): Boolean {
        return try {
            reactContext.packageManager.getPackageInfo(packageName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }
}
