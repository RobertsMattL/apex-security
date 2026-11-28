package com.tactical.seccam.ui.components

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
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
import com.tactical.seccam.SecCamApp
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.delay
import java.util.Locale

/** Playback state of one event clip, shared by the video surface and its transport bar. */
@Stable
class ClipState internal constructor(val player: ExoPlayer) {
    var paused by mutableStateOf(false)
    var positionMs by mutableLongStateOf(0L)
    var durationMs by mutableLongStateOf(0L)
    var speed by mutableFloatStateOf(1f)
    var error by mutableStateOf<String?>(null)
    /** Fraction under the user's finger while dragging the scrubber; playback holds meanwhile. */
    var scrubbing by mutableStateOf<Float?>(null)
    /** Last double-tap skip (-1 back, +1 forward) and when, for the on-video flash. */
    var skipFlash by mutableStateOf(0 to 0L)

    /** Skip size: 2 s for typical short clips, 5 s once a clip is long enough for it to matter. */
    val stepMs get() = if (durationMs in 1..20_000) 2_000L else 5_000L

    fun seekTo(ms: Long) {
        val d = durationMs
        // Stop just short of the end: seeking exactly to it would loop straight back to 0.
        val t = if (d > 0) ms.coerceIn(0, (d - 100).coerceAtLeast(0)) else ms.coerceAtLeast(0)
        player.seekTo(t)
        positionMs = t
    }

    fun seekBy(deltaMs: Long) = seekTo(player.currentPosition + deltaMs)

    fun skip(dir: Int) {
        seekBy(dir * stepMs)
        skipFlash = dir to System.currentTimeMillis()
    }

    fun togglePause() { paused = !paused }

    fun cycleSpeed() {
        speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.size]
        player.setPlaybackSpeed(speed)
    }

    companion object {
        val SPEEDS = listOf(1f, 2f, 4f, 0.5f)
    }
}

private val repo @Composable get() = (LocalContext.current.applicationContext as SecCamApp).repo

/**
 * Event clip playback: progressive MP4 from a signed URL, looped and muted (clips have
 * no audio). Plays only while its pager page is the settled one and the app is resumed.
 */
@OptIn(UnstableApi::class)
@Composable
fun rememberClipState(eventId: String, url: String, active: Boolean): ClipState {
    val context = LocalContext.current
    val repo = repo
    val state = remember(eventId) {
        val player = ExoPlayer.Builder(context)
            // Keep what was already played in memory so rewinding doesn't re-download.
            .setLoadControl(DefaultLoadControl.Builder().setBackBuffer(60_000, true).build())
            .build().apply {
                volume = 0f
                repeatMode = Player.REPEAT_MODE_ONE
                setMediaItem(MediaItem.fromUri(repo.api.absolute(url)))
                prepare()
            }
        ClipState(player)
    }
    DisposableEffect(state) {
        val l = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) { state.error = e.errorCodeName.removePrefix("ERROR_CODE_") }
        }
        state.player.addListener(l)
        onDispose { state.player.removeListener(l); state.player.release() }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember { mutableStateOf(true) }
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_PAUSE) resumed = false
            if (e == Lifecycle.Event.ON_RESUME) resumed = true
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(active) { if (!active) { state.player.seekTo(0); state.paused = false } }
    state.player.playWhenReady = active && resumed && !state.paused && state.scrubbing == null
    LaunchedEffect(state) {
        while (true) {
            state.durationMs = state.player.duration.takeIf { it > 0 } ?: 0L
            if (state.scrubbing == null) state.positionMs = state.player.currentPosition
            delay(100)
        }
    }
    return state
}

/**
 * The video surface. Tap pauses/resumes; double-tap the left or right half to skip back or
 * forward. Taps don't consume drags, so horizontal swipes still reach the event pager.
 */
@OptIn(UnstableApi::class)
@Composable
fun ClipPlayer(state: ClipState, modifier: Modifier = Modifier, zoom: ZoomState? = null) {
    Box(modifier.background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                texturePlayerView(ctx).apply {
                    isClickable = false
                    isFocusable = false
                    player = state.player
                }
            },
            modifier = Modifier.fillMaxSize().then(if (zoom != null) Modifier.zoomed(zoom) else Modifier),
        )
        Box(
            Modifier.matchParentSize().pointerInput(state) {
                detectTapGestures(
                    onTap = { state.togglePause() },
                    onDoubleTap = { p -> state.skip(if (p.x < size.width / 2f) -1 else 1) },
                )
            },
        )
        Row(Modifier.align(Alignment.TopStart).padding(10.dp).background(Tac.Void.copy(alpha = 0.6f)).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            val label = when {
                state.error != null -> "CLIP ERROR · ${state.error}"
                state.paused -> "❚❚ PAUSED"
                else -> "▶ CLIP"
            }
            Text(label + if (state.speed != 1f) " · ${speedLabel(state.speed)}" else "", style = Tac.DataSmall.copy(color = if (state.error != null) Tac.Amber else Tac.Cyan))
        }
        // Brief "« 2s" / "2s »" flash on the side that was double-tapped.
        val (dir, at) = state.skipFlash
        var showFlash by remember { mutableStateOf(false) }
        LaunchedEffect(at) { if (at > 0) { showFlash = true; delay(650); showFlash = false } }
        if (showFlash && dir != 0) {
            val secs = state.stepMs / 1000
            Text(
                if (dir < 0) "«  ${secs}s" else "${secs}s  »",
                style = Tac.Data.copy(color = Tac.Text),
                modifier = Modifier.align(if (dir < 0) Alignment.CenterStart else Alignment.CenterEnd).padding(horizontal = 48.dp)
                    .background(Tac.Void.copy(alpha = 0.6f), RoundedCornerShape(2.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

/** Transport bar under the clip: scrubber, skip back/forward, play/pause, speed, time. */
@Composable
fun ClipControls(state: ClipState, modifier: Modifier = Modifier) {
    val d = state.durationMs
    val frac = state.scrubbing ?: if (d > 0) (state.positionMs.toFloat() / d).coerceIn(0f, 1f) else 0f
    val shownMs = state.scrubbing?.let { (it * d).toLong() } ?: state.positionMs
    androidx.compose.foundation.layout.Column(modifier.fillMaxWidth()) {
        Scrubber(frac, enabled = d > 0, onScrub = { f ->
            state.scrubbing = f
            if (f != null) state.seekTo((f * d).toLong())
        })
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val step = state.stepMs / 1000
            CtlChip("« ${step}s", onClick = { state.skip(-1) })
            CtlChip(if (state.paused) "▶" else "❚❚", onClick = { state.togglePause() }, accent = true, minWidth = 52)
            CtlChip("${step}s »", onClick = { state.skip(1) })
            CtlChip(speedLabel(state.speed), onClick = { state.cycleSpeed() }, accent = state.speed != 1f)
            Spacer(Modifier.weight(1f))
            Text("${mmssTenths(shownMs)} / ${Fmt.mmss(d)}", style = Tac.DataSmall.copy(color = Tac.Text.copy(alpha = 0.85f)))
        }
    }
}

/** Drag or tap anywhere on the bar to seek. Consumes its drags so the pager doesn't swipe. */
@Composable
private fun Scrubber(frac: Float, enabled: Boolean, onScrub: (Float?) -> Unit) {
    var widthPx by remember { mutableFloatStateOf(1f) }
    val thumb = 14.dp
    val thumbPx = with(LocalDensity.current) { thumb.toPx() }
    Box(
        Modifier.fillMaxWidth().height(30.dp).onSizeChanged { widthPx = it.width.toFloat().coerceAtLeast(1f) }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown()
                    down.consume()
                    onScrub((down.position.x / widthPx).coerceIn(0f, 1f))
                    while (true) {
                        val ev = awaitPointerEvent()
                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                        if (!ch.pressed) break
                        ch.consume()
                        onScrub((ch.position.x / widthPx).coerceIn(0f, 1f))
                    }
                    onScrub(null)
                }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().height(3.dp).background(Tac.Hairline)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(Tac.Cyan))
        }
        // Before the first measure widthPx is a placeholder smaller than the thumb: keep the range non-empty.
        val x = with(LocalDensity.current) { ((frac * widthPx) - thumbPx / 2).coerceIn(0f, (widthPx - thumbPx).coerceAtLeast(0f)).toDp() }
        Box(Modifier.offset(x = x).size(thumb).background(Tac.Cyan, CircleShape))
    }
}

@Composable
private fun CtlChip(label: String, onClick: () -> Unit, accent: Boolean = false, minWidth: Int = 0) {
    val c = if (accent) Tac.Cyan else Tac.TextDim
    Box(
        Modifier.widthIn(min = minWidth.dp)
            .background(Tac.Void.copy(alpha = 0.72f), RoundedCornerShape(2.dp))
            .border(1.dp, c.copy(alpha = 0.5f), RoundedCornerShape(2.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = Tac.DataSmall.copy(color = c))
    }
}

private fun speedLabel(s: Float) = if (s < 1f) "${s}×" else "${s.toInt()}×"

private fun mmssTenths(ms: Long) = String.format(Locale.US, "%d:%02d.%d", ms / 60000, (ms / 1000) % 60, (ms / 100) % 10)
