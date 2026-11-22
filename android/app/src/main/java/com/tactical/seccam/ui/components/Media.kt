package com.tactical.seccam.ui.components

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import com.tactical.seccam.SecCamApp
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.delay

private val repo @Composable get() = (LocalContext.current.applicationContext as SecCamApp).repo

/**
 * Live view through the server's MediaMTX (tacticalRtsp's streaming layer). The server
 * issues a short-lived stream token that is used as the RTSP password; camera
 * credentials never reach the phone. Retries with a fresh token on failure.
 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayer(cameraId: String, modifier: Modifier = Modifier, online: Boolean = true) {
    val context = LocalContext.current
    val repo = repo
    var attempt by remember { mutableIntStateOf(0) }
    var phase by remember { mutableStateOf("ACQUIRING") }
    var error by remember { mutableStateOf<String?>(null) }

    val player = remember {
        ExoPlayer.Builder(context)
            // Live view favours latency over smoothness: start fast, keep a small buffer.
            .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(500, 3000, 250, 500).build())
            .build().apply { volume = 0f }
    }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                phase = when (state) {
                    Player.STATE_BUFFERING -> "BUFFERING"
                    Player.STATE_READY -> "LIVE"
                    Player.STATE_ENDED -> "ENDED"
                    else -> phase
                }
                if (state == Player.STATE_READY) error = null
            }

            override fun onPlayerError(e: PlaybackException) {
                error = e.errorCodeName.removePrefix("ERROR_CODE_")
                phase = "SIGNAL LOST"
                attempt++
            }
        }
        player.addListener(l)
        onDispose { player.removeListener(l); player.release() }
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_STOP -> player.stop()
                Lifecycle.Event.ON_START -> if (player.playbackState == Player.STATE_IDLE && player.mediaItemCount > 0) attempt++
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }

    LaunchedEffect(cameraId, attempt, online) {
        if (!online) { phase = "NO SIGNAL"; return@LaunchedEffect }
        if (attempt > 0) delay(2500)
        phase = "ACQUIRING"
        try {
            val ticket = repo.api.streamTicket(cameraId)
            val source = RtspMediaSource.Factory()
                .setForceUseRtpTcp(true) // reliable through NAT/Wi-Fi; MediaMTX supports both
                .setTimeoutMs(8000)
                .createMediaSource(MediaItem.fromUri(ticket.url))
            player.setMediaSource(source)
            player.prepare()
            player.playWhenReady = true
        } catch (e: Exception) {
            error = e.message
            phase = "SIGNAL LOST"
            attempt++
        }
    }

    Box(modifier.background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    setKeepContentOnPlayerReset(true)
                    this.player = player
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        ScanlineOverlay()
        Box(Modifier.matchParentSize().cornerBrackets(Tac.Cyan.copy(alpha = 0.7f), 16.dp, 1.5.dp, 8.dp))
        Row(Modifier.align(Alignment.TopStart).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            val c = when (phase) { "LIVE" -> Tac.Red; "SIGNAL LOST", "NO SIGNAL" -> Tac.Amber; else -> Tac.Cyan }
            StatusPip(c, pulse = true, size = 6.dp)
            Text(if (phase == "LIVE") "● REC/LIVE" else phase, style = Tac.DataSmall.copy(color = c))
        }
        Box(Modifier.align(Alignment.TopEnd).padding(14.dp)) { HudClock(Tac.DataSmall.copy(color = Tac.Text.copy(alpha = 0.8f))) }
        if (phase != "LIVE") {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(phase, style = Tac.Title.copy(color = Tac.TextDim))
                error?.let { Spacer(Modifier.height(4.dp)); Text(it.take(60), style = Tac.DataSmall.copy(color = Tac.TextFaint)) }
            }
        }
    }
}

/** Latest frame from a camera (server-side grab via MediaMTX), refreshed periodically. */
@Composable
fun CameraSnapshot(cameraId: String, modifier: Modifier = Modifier, refreshMs: Long = 15_000, online: Boolean = true) {
    val repo = repo
    val context = LocalContext.current
    var token by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(cameraId, online) {
        while (online) {
            token = runCatching { repo.api.accessToken() }.getOrNull()
            delay(refreshMs)
            tick++
        }
    }
    Box(modifier.background(Tac.Void)) {
        val t = token
        if (t != null && online) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(repo.api.absolute("/api/cameras/$cameraId/snapshot"))
                    .addHeader("Authorization", "Bearer $t")
                    .memoryCacheKey("snap:$cameraId:$tick")
                    .placeholderMemoryCacheKey(if (tick > 0) "snap:$cameraId:${tick - 1}" else null)
                    .diskCachePolicy(CachePolicy.DISABLED)
                    .build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text("NO SIGNAL", style = Tac.Label.copy(color = Tac.TextFaint), modifier = Modifier.align(Alignment.Center))
        }
        ScanlineOverlay()
    }
}

/** Detection frame. URLs are signed and expire, so the cache key is the event id. */
@Composable
fun EventImage(eventId: String, url: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop) {
    val repo = repo
    val context = LocalContext.current
    Box(modifier.background(Tac.Void)) {
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(repo.api.absolute(url))
                    .memoryCacheKey("event:$eventId")
                    .diskCacheKey("event:$eventId")
                    .build(),
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text("NO FRAME", style = Tac.Label.copy(color = Tac.TextFaint), modifier = Modifier.align(Alignment.Center))
        }
    }
}
