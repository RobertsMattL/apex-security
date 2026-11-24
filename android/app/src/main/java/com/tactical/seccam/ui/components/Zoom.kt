package com.tactical.seccam.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.unit.dp
import com.tactical.seccam.ui.theme.Tac
import java.util.Locale

/** Pinch-zoom / pan state for one piece of media. */
@Stable
class ZoomState(private val maxScale: Float = 6f) {
    var scale by mutableFloatStateOf(1f)
        private set
    var offset by mutableStateOf(Offset.Zero)
        private set
    val zoomed get() = scale > 1.01f

    fun reset() { scale = 1f; offset = Offset.Zero }

    /** Zoom by [zoom] about [centroid] (relative to the view centre), then pan; keeps the content covering the view. */
    internal fun transform(zoom: Float, pan: Offset, centroid: Offset, width: Float, height: Float) {
        val s = (scale * zoom).coerceIn(1f, maxScale)
        var o = centroid - (centroid - offset) * (s / scale) + pan
        val mx = (s - 1f) * width / 2f
        val my = (s - 1f) * height / 2f
        o = Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
        scale = s
        offset = if (s <= 1.001f) Offset.Zero else o
    }
}

@Composable
fun rememberZoomState(vararg keys: Any?) = remember(*keys) { ZoomState() }

/**
 * Gesture area: two fingers pinch-zoom and pan; once zoomed, one finger pans.
 * At 1x single-finger drags are left alone so the event pager still swipes.
 */
fun Modifier.pinchZoomInput(state: ZoomState): Modifier = clipToBounds().pointerInput(state) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        do {
            val event = awaitPointerEvent()
            val fingers = event.changes.count { it.pressed }
            if (fingers >= 2 || state.zoomed) {
                val c = event.calculateCentroid(useCurrent = true)
                val centre = Offset(size.width / 2f, size.height / 2f)
                state.transform(event.calculateZoom(), event.calculatePan(), if (c == Offset.Unspecified) Offset.Zero else c - centre, size.width.toFloat(), size.height.toFloat())
                event.changes.forEach { if (it.positionChanged()) it.consume() }
            }
        } while (event.changes.any { it.pressed })
    }
}

/** Apply the zoom transform to the content being zoomed (not to overlays). */
fun Modifier.zoomed(state: ZoomState): Modifier = graphicsLayer {
    scaleX = state.scale
    scaleY = state.scale
    translationX = state.offset.x
    translationY = state.offset.y
}

/** "2.4× · RESET" chip, shown while zoomed. */
@Composable
fun ZoomBadge(state: ZoomState, modifier: Modifier = Modifier) {
    if (!state.zoomed) return
    Text(
        String.format(Locale.US, "%.1f× · RESET", state.scale),
        style = Tac.DataSmall.copy(color = Tac.Cyan),
        modifier = modifier
            .background(Tac.Void.copy(alpha = 0.72f), RoundedCornerShape(2.dp))
            .border(1.dp, Tac.Cyan.copy(alpha = 0.45f), RoundedCornerShape(2.dp))
            .clickable { state.reset() }
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}
