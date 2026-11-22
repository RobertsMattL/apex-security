package com.tactical.seccam.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.tactical.seccam.MainActivity
import com.tactical.seccam.R
import com.tactical.seccam.data.AlertItem
import com.tactical.seccam.data.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Request

/** System notifications for detection alerts, with the captured frame as a big picture. */
class Notifier(private val context: Context, private val api: ApiClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Detection alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "People and animals detected by your cameras"
            enableLights(true)
            lightColor = 0xFFFFB020.toInt()
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_LINK, "Server connection", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps the alert connection open"
            setShowBadge(false)
        })
    }

    fun show(a: AlertItem) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        scope.launch {
            val bitmap = a.imageUrl?.let { url ->
                runCatching {
                    api.http.newCall(Request.Builder().url(api.absolute(url)).build()).execute().use { r ->
                        if (r.isSuccessful) BitmapFactory.decodeStream(r.body!!.byteStream()) else null
                    }
                }.getOrNull()
            }
            val open = PendingIntent.getActivity(
                context, a.id.hashCode(),
                Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_ALERT_ID, a.id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val b = NotificationCompat.Builder(context, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setColor(if (a.kind == "person") 0xFFFF4D5E.toInt() else 0xFFFFB020.toInt())
                .setContentTitle("${a.title} · ${a.cameraName.uppercase()}")
                .setContentText("${a.label} ${(a.confidence * 100).toInt()}%")
                .setWhen(a.createdAt)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(open)
                .setGroup(GROUP)
            if (bitmap != null) b.setLargeIcon(bitmap).setStyle(NotificationCompat.BigPictureStyle().bigPicture(bitmap).bigLargeIcon(null as android.graphics.Bitmap?))
            runCatching { NotificationManagerCompat.from(context).notify(a.id.hashCode(), b.build()) }
        }
    }

    fun cancel(id: String) = NotificationManagerCompat.from(context).cancel(id.hashCode())

    companion object {
        const val CHANNEL_ALERTS = "alerts"
        const val CHANNEL_LINK = "link"
        const val GROUP = "detections"
    }
}
