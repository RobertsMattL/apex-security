package com.tactical.seccam.service

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.tactical.seccam.MainActivity
import com.tactical.seccam.R
import com.tactical.seccam.SecCamApp

/**
 * Foreground service that keeps the process (and so the WebSocket owned by the
 * Repository) alive while the app is in the background, so alerts arrive in real time
 * without a cloud push service. The connection itself lives in [com.tactical.seccam.data.RealtimeClient].
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifier.CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle("Apex Security monitoring")
            .setContentText("Connected to your camera server for live alerts")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        runCatching { ServiceCompat.startForeground(this, 1, n, type) }
        val repo = (application as SecCamApp).repo
        if (repo.session.signedIn) repo.realtime.start() else stopSelf()
        return START_STICKY
    }

    companion object {
        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, ConnectionService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
