package com.tactical.seccam.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.Camera
import com.tactical.seccam.data.DetectionEventItem
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.CameraSnapshot
import com.tactical.seccam.ui.components.Chip
import com.tactical.seccam.ui.components.EmptyState
import com.tactical.seccam.ui.components.EventImage
import com.tactical.seccam.ui.components.Fmt
import com.tactical.seccam.ui.components.FullScreen
import com.tactical.seccam.ui.components.GlassPanel
import com.tactical.seccam.ui.components.IconTextButton
import com.tactical.seccam.ui.components.LinkIndicator
import com.tactical.seccam.ui.components.SectionHeader
import com.tactical.seccam.ui.components.StatusPip
import com.tactical.seccam.ui.components.TacButton
import com.tactical.seccam.ui.components.TopBar
import com.tactical.seccam.ui.components.cornerBrackets
import com.tactical.seccam.ui.components.streamColor
import com.tactical.seccam.ui.theme.Tac

@Composable
fun DashboardScreen(
    repo: Repository,
    onCamera: (String) -> Unit,
    onAddCamera: () -> Unit,
    onAlerts: () -> Unit,
    onEvent: (String) -> Unit,
    onSettings: () -> Unit,
) {
    val cameras by repo.cameras.collectAsStateWithLifecycle()
    val alerts by repo.alerts.alerts.collectAsStateWithLifecycle()
    val activity by repo.activity.collectAsStateWithLifecycle()
    val link by repo.link.collectAsStateWithLifecycle()
    val error by repo.lastError.collectAsStateWithLifecycle()
    val unread = remember(alerts) { alerts.count { !it.read } }
    val lastByCamera = remember(activity) { activity.groupBy { it.cameraId }.mapValues { it.value.first() } }

    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar("APEX SECURITY", subtitle = repo.session.serverUrl.removePrefix("http://").removePrefix("https://")) {
                LinkIndicator(link)
                IconTextButton("ALERTS", color = if (unread > 0) Tac.Amber else Tac.Cyan, badge = unread, onClick = onAlerts)
                IconTextButton("SYS", color = Tac.TextDim, onClick = onSettings)
            }
            LazyVerticalGrid(
                columns = GridCells.Adaptive(300.dp),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize().navigationBarsPadding(),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Column {
                        error?.let { Text("⚠ $it", style = Tac.DataSmall.copy(color = Tac.Amber), modifier = Modifier.padding(top = 10.dp)) }
                        StatsStrip(cameras, unread)
                        SectionHeader("Cameras") { Text("${cameras.size} UNITS", style = Tac.DataSmall) }
                    }
                }
                if (cameras.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        EmptyState("No cameras", "Add an RTSP camera to begin monitoring.") { TacButton("+ Add camera", onAddCamera, primary = true) }
                    }
                } else {
                    items(cameras, key = { it.id }) { cam -> CameraCard(cam, lastByCamera[cam.id], onClick = { onCamera(cam.id) }) }
                    item { AddCameraCard(onAddCamera) }
                }
                item(span = { GridItemSpan(maxLineSpan) }) { SectionHeader("Recent activity") { Text("LAST ${activity.size}", style = Tac.DataSmall) } }
                if (activity.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) { Text("No detections yet.", style = Tac.Body.copy(color = Tac.TextFaint)) }
                } else {
                    items(activity.take(12), key = { "a" + it.id }, span = { GridItemSpan(maxLineSpan) }) { ev -> ActivityRow(ev) { onEvent(ev.id) } }
                }
            }
        }
    }
}

@Composable
private fun StatsStrip(cameras: List<Camera>, unread: Int) {
    val online = cameras.count { it.status.online }
    val detecting = cameras.count { it.status.detector == "running" }
    Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Metric("Online", "$online/${cameras.size}", if (online == cameras.size && cameras.isNotEmpty()) Tac.Green else if (online == 0 && cameras.isNotEmpty()) Tac.Red else Tac.Amber, Modifier.weight(1f))
        Metric("Detect", "$detecting", if (detecting > 0) Tac.Cyan else Tac.TextFaint, Modifier.weight(1f))
        Metric("Unread", "$unread", if (unread > 0) Tac.Amber else Tac.TextFaint, Modifier.weight(1f))
    }
}

@Composable
private fun Metric(label: String, value: String, color: Color, modifier: Modifier) {
    GlassPanel(modifier, padding = 11.dp) {
        Text(label.uppercase(), style = Tac.Label)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, style = Tac.Metric.copy(color = color))
        }
        Box(Modifier.padding(top = 6.dp).fillMaxWidth().height(2.dp).background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.7f), Color.Transparent))))
    }
}

@Composable
private fun CameraCard(cam: Camera, last: DetectionEventItem?, onClick: () -> Unit) {
    val sc = streamColor(cam.status.stream)
    GlassPanel(Modifier.fillMaxWidth().animateContentSize(), onClick = onClick, padding = 0.dp) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
            CameraSnapshot(cam.id, Modifier.fillMaxSize(), online = cam.status.online)
            Box(Modifier.matchParentSize().background(Brush.verticalGradient(listOf(Color(0x99000000), Color.Transparent, Color.Transparent, Color(0xCC000000)))))
            Box(Modifier.matchParentSize().cornerBrackets(sc.copy(alpha = 0.8f), 12.dp, 1.5.dp, 8.dp))
            Row(Modifier.align(Alignment.TopStart).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusPip(sc, pulse = cam.status.stream != "online", size = 6.dp)
                Text(cam.status.stream.uppercase(), style = Tac.DataSmall.copy(color = sc))
            }
            cam.status.tracks.firstOrNull()?.let {
                Text(it, style = Tac.DataSmall.copy(color = Tac.Text.copy(alpha = 0.7f)), modifier = Modifier.align(Alignment.TopEnd).padding(14.dp))
            }
            Column(Modifier.align(Alignment.BottomStart).padding(12.dp)) {
                Text(cam.name.uppercase(), style = Tac.Title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    last?.let { "LAST ${Fmt.kind(it.kind)} · ${Fmt.ago(it.createdAt)}" } ?: "NO RECENT DETECTIONS",
                    style = Tac.DataSmall.copy(color = if (last != null) Tac.kindColor(last.kind) else Tac.TextDim),
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            cam.listeners.forEach { l -> Chip(Fmt.kind(l.kind), if (l.enabled) Tac.kindColor(l.kind) else Tac.TextFaint, filled = l.enabled) }
            Spacer(Modifier.weight(1f))
            val det = cam.status.detector
            Text(
                "DET ${det.uppercase()}",
                style = Tac.DataSmall.copy(color = when (det) { "running" -> Tac.Cyan; "error" -> Tac.Red; "starting" -> Tac.Amber; else -> Tac.TextFaint }),
            )
            if (!cam.notificationsEnabled) Chip("MUTED", Tac.TextFaint)
        }
    }
}

@Composable
private fun AddCameraCard(onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(3.dp))
            .border(1.dp, Tac.Hairline, RoundedCornerShape(3.dp))
            .cornerBrackets(Tac.Cyan.copy(alpha = 0.5f), 12.dp, 1.5.dp, 8.dp)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("+", style = Tac.Headline.copy(color = Tac.Cyan))
            Text("ADD CAMERA", style = Tac.Label.copy(color = Tac.Cyan))
        }
    }
}

@Composable
fun ActivityRow(ev: DetectionEventItem, onClick: () -> Unit) {
    val c = Tac.kindColor(ev.kind)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(2.dp)).background(Tac.Charcoal.copy(alpha = 0.5f)).border(1.dp, Tac.HairlineDim, RoundedCornerShape(2.dp)).clickable(onClick = onClick).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(40.dp).background(c))
        Spacer(Modifier.width(10.dp))
        EventImage(ev.id, ev.imageUrl, Modifier.size(width = 72.dp, height = 40.dp).clip(RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("${Fmt.kind(ev.kind)} · ${ev.cameraName.uppercase()}", style = Tac.Data.copy(color = Tac.Text), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${ev.label} ${Fmt.pct(ev.confidence)}${ev.trackId?.let { " · TRK #$it" } ?: ""}", style = Tac.DataSmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(Fmt.clock(ev.createdAt), style = Tac.Data.copy(color = Tac.TextDim))
            Text(Fmt.ago(ev.createdAt), style = Tac.DataSmall.copy(color = Tac.TextFaint))
        }
    }
}
