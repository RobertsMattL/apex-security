package com.tactical.seccam.ui.screens

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.DetectionEventItem
import com.tactical.seccam.data.EventRef
import com.tactical.seccam.data.ListenerSettings
import com.tactical.seccam.data.ProbeResult
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.Chip
import com.tactical.seccam.ui.components.EventImage
import com.tactical.seccam.ui.components.Fmt
import com.tactical.seccam.ui.components.FullScreen
import com.tactical.seccam.ui.components.GlassPanel
import com.tactical.seccam.ui.components.KeyValue
import com.tactical.seccam.ui.components.LivePlayer
import com.tactical.seccam.ui.components.SectionHeader
import com.tactical.seccam.ui.components.TacButton
import com.tactical.seccam.ui.components.TacSlider
import com.tactical.seccam.ui.components.ToggleRow
import com.tactical.seccam.ui.components.TopBar
import com.tactical.seccam.ui.components.streamColor
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.launch

@Composable
fun CameraDetailScreen(repo: Repository, cameraId: String, onBack: () -> Unit, onEvent: (String) -> Unit) {
    val cameras by repo.cameras.collectAsStateWithLifecycle()
    val cam = cameras.firstOrNull { it.id == cameraId }
    val eventsVersion by repo.eventsVersion.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var fullscreen by remember { mutableStateOf(false) }
    var events by remember { mutableStateOf<List<DetectionEventItem>>(emptyList()) }
    var probe by remember { mutableStateOf<ProbeResult?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Slider drafts so dragging doesn't spam the server; committed on release.
    val drafts = remember { mutableStateMapOf<String, ListenerSettings>() }

    LaunchedEffect(cameraId, eventsVersion) { runCatching { repo.api.events(cameraId, limit = 500) }.onSuccess { events = it } }

    if (cam == null) {
        FullScreen { Column { TopBar("Camera", onBack = onBack); Text("Camera removed.", style = Tac.Body, modifier = Modifier.padding(20.dp)) } }
        return
    }

    fun saveListeners(list: List<ListenerSettings>) = scope.launch {
        runCatching { repo.api.updateSettings(cam.id, null, list) }.onFailure { error = it.message }
    }

    FullscreenController(fullscreen)
    BackHandler(fullscreen) { fullscreen = false }

    if (fullscreen) {
        Box(Modifier.fillMaxSize()) {
            LivePlayer(cam.id, Modifier.fillMaxSize(), online = cam.status.online)
            Box(Modifier.align(Alignment.BottomEnd).padding(18.dp)) { TacButton("Exit", { fullscreen = false }) }
            Text(cam.name.uppercase(), style = Tac.Title, modifier = Modifier.align(Alignment.BottomStart).padding(22.dp))
        }
        return
    }

    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar(cam.name, subtitle = "UNIT ${cam.id.take(8).uppercase()}", onBack = onBack) {
                Chip(cam.status.stream, streamColor(cam.status.stream), filled = true)
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 14.dp)) {
                Spacer(Modifier.height(12.dp))
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(3.dp)).clickable { fullscreen = true }) {
                    LivePlayer(cam.id, Modifier.fillMaxSize(), online = cam.status.online)
                }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                    Text("TAP FEED FOR FULLSCREEN", style = Tac.DataSmall.copy(color = Tac.TextFaint))
                }

                SectionHeader("Recent detections") { Text("${events.size}", style = Tac.DataSmall) }
                if (events.isEmpty()) Text("Nothing detected yet.", style = Tac.Body.copy(color = Tac.TextFaint))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(events, key = { it.id }) { ev ->
                        Column(Modifier.width(150.dp).clickable { repo.setEventSequence(events.map { EventRef(it.id) }); onEvent(ev.id) }) {
                            Box {
                                EventImage(ev.id, ev.imageUrl, Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(2.dp)))
                                Box(Modifier.padding(5.dp)) { Chip(Fmt.kind(ev.kind), Tac.kindColor(ev.kind), filled = true) }
                            }
                            Text("${Fmt.clock(ev.createdAt)} · ${Fmt.pct(ev.confidence)}", style = Tac.DataSmall, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                }

                SectionHeader("Alerts")
                GlassPanel(Modifier.fillMaxWidth()) {
                    ToggleRow("Notifications", "Push alerts for this camera to your devices", cam.notificationsEnabled, { on ->
                        scope.launch { runCatching { repo.api.updateSettings(cam.id, on, null) }.onFailure { error = it.message } }
                    }, accent = Tac.Amber)
                }

                SectionHeader("Detection listeners")
                cam.listeners.forEach { base ->
                    val l = drafts[base.kind] ?: base
                    val kc = Tac.kindColor(l.kind)
                    GlassPanel(Modifier.fillMaxWidth().padding(bottom = 10.dp), accent = if (l.enabled) kc.copy(alpha = 0.7f) else null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${Fmt.kind(l.kind)} DETECTION", style = Tac.Title.copy(color = if (l.enabled) kc else Tac.TextDim), modifier = Modifier.weight(1f))
                        }
                        ToggleRow("Detect", "Record ${l.label.lowercase()} events from this feed", l.enabled, { on -> saveListeners(listOf(l.copy(enabled = on))) }, accent = kc)
                        ToggleRow("Notify", "Send an alert for each new ${l.label.lowercase()}", l.notify, { on -> saveListeners(listOf(l.copy(notify = on))) }, enabled = l.enabled && cam.notificationsEnabled, accent = kc)
                        TacSlider(
                            "Confidence threshold", l.minConfidence.toFloat(), Fmt.pct(l.minConfidence), 0.2f..0.95f, enabled = l.enabled,
                            onChange = { drafts[l.kind] = l.copy(minConfidence = (it * 100).toInt() / 100.0) },
                            onDone = { drafts.remove(l.kind)?.let { saveListeners(listOf(it)) } },
                        )
                        TacSlider(
                            "Clip / cooldown", l.cooldownSec.toFloat(), cooldownText(l.cooldownSec), 0f..120f, enabled = l.enabled,
                            onChange = { drafts[l.kind] = l.copy(cooldownSec = (it / 5).toInt() * 5) },
                            onDone = { drafts.remove(l.kind)?.let { saveListeners(listOf(it)) } },
                        )
                    }
                }

                SectionHeader("Link telemetry")
                GlassPanel(Modifier.fillMaxWidth()) {
                    KeyValue("Stream", cam.status.stream.uppercase(), streamColor(cam.status.stream))
                    KeyValue("Since", if (cam.status.since > 0) "${Fmt.stamp(cam.status.since)} (${Fmt.ago(cam.status.since)})" else "—")
                    KeyValue("Tracks", cam.status.tracks.joinToString().ifBlank { "—" })
                    KeyValue("Viewers", "${cam.status.readers}")
                    KeyValue("Detector", cam.status.detector.uppercase(), when (cam.status.detector) { "running" -> Tac.Cyan; "error" -> Tac.Red; else -> Tac.TextDim })
                    cam.status.message?.let { KeyValue("Message", it, Tac.Amber) }
                    KeyValue("Source", cam.rtspUrl)
                    KeyValue("Auth", if (cam.hasCredentials) "STORED ON SERVER" else "NONE")
                    KeyValue("Transport", cam.transport.uppercase())
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        TacButton(if (busy) "Testing…" else "Test link", {
                            scope.launch { busy = true; probe = runCatching { repo.api.retestCamera(cam.id) }.getOrElse { ProbeResult(false, it.message, null, 0) }; busy = false }
                        }, enabled = !busy)
                        probe?.let { Text(if (it.ok) "OK · ${it.summary} · ${it.latencyMs}ms" else "FAIL · ${it.error}", style = Tac.DataSmall.copy(color = if (it.ok) Tac.Green else Tac.Red)) }
                    }
                }

                error?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.Red), modifier = Modifier.padding(top = 8.dp)) }

                SectionHeader("Unit")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TacButton(if (cam.enabled) "Disable feed" else "Enable feed", {
                        scope.launch { runCatching { repo.upsertCamera(repo.api.updateCamera(cam.id, org.json.JSONObject().put("enabled", !cam.enabled))) }.onFailure { error = it.message } }
                    }, accent = Tac.Amber)
                    TacButton(if (confirmDelete) "Confirm remove" else "Remove", {
                        if (!confirmDelete) confirmDelete = true
                        else scope.launch { runCatching { repo.api.deleteCamera(cam.id) }.onSuccess { repo.removeCameraLocal(cam.id); onBack() }.onFailure { error = it.message } }
                    }, accent = Tac.Red, primary = confirmDelete)
                }
                Spacer(Modifier.height(36.dp))
            }
        }
    }
}

private fun cooldownText(s: Int) = when {
    s == 0 -> "OFF"
    s < 60 -> "${s}s"
    s % 60 == 0 -> "${s / 60}m"
    else -> "${s / 60}m ${s % 60}s"
}

/** Landscape + immersive while the feed is fullscreen. */
@Composable
private fun FullscreenController(fullscreen: Boolean) {
    val activity = LocalContext.current as? Activity ?: return
    DisposableEffect(fullscreen) {
        val ctl = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (fullscreen) {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            ctl.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            ctl.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
