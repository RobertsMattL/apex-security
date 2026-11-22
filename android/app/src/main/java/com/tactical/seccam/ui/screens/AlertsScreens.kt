package com.tactical.seccam.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.AlertItem
import com.tactical.seccam.data.DetectionEventItem
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.Chip
import com.tactical.seccam.ui.components.EmptyState
import com.tactical.seccam.ui.components.EventImage
import com.tactical.seccam.ui.components.Fmt
import com.tactical.seccam.ui.components.FullScreen
import com.tactical.seccam.ui.components.GlassPanel
import com.tactical.seccam.ui.components.KeyValue
import com.tactical.seccam.ui.components.SectionHeader
import com.tactical.seccam.ui.components.TacButton
import com.tactical.seccam.ui.components.TopBar
import com.tactical.seccam.ui.components.cornerBrackets
import com.tactical.seccam.ui.theme.Tac

/** Notification center: inbox grouped by day, filterable by unread / camera. */
@Composable
fun AlertsScreen(repo: Repository, onBack: () -> Unit, onOpen: (AlertItem) -> Unit) {
    val alerts by repo.alerts.alerts.collectAsStateWithLifecycle()
    val cameras by repo.cameras.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf("all") } // all | unread | camera id
    val shown = remember(alerts, filter) {
        when (filter) {
            "all" -> alerts
            "unread" -> alerts.filter { !it.read }
            else -> alerts.filter { it.cameraId == filter }
        }
    }
    val unread = alerts.count { !it.read }

    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar("Alerts", subtitle = "$unread UNREAD · ${alerts.size} TOTAL", onBack = onBack) {
                if (unread > 0) TacButton("Mark all read", { repo.markAllRead() }, accent = Tac.Amber)
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Chip("All", if (filter == "all") Tac.Cyan else Tac.TextDim, filled = filter == "all") { filter = "all" }
                Chip("Unread $unread", if (filter == "unread") Tac.Amber else Tac.TextDim, filled = filter == "unread") { filter = "unread" }
                cameras.forEach { c -> Chip(c.name, if (filter == c.id) Tac.Cyan else Tac.TextDim, filled = filter == c.id) { filter = c.id } }
            }
            if (shown.isEmpty()) {
                EmptyState(if (filter == "unread") "All clear" else "No alerts", "Detections from your cameras will appear here in real time.")
            } else {
                val grouped = remember(shown) { shown.groupBy { Fmt.dayHeader(it.createdAt) } }
                LazyColumn(Modifier.fillMaxSize().navigationBarsPadding(), contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    grouped.forEach { (day, list) ->
                        item(key = "h$day") { SectionHeader(day) { Text("${list.size}", style = Tac.DataSmall) } }
                        items(list, key = { it.id }) { a -> AlertRow(a) { onOpen(a) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun AlertRow(a: AlertItem, onClick: () -> Unit) {
    val c = Tac.kindColor(a.kind)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(3.dp))
            .background(if (a.read) Tac.Charcoal.copy(alpha = 0.35f) else Tac.Raised.copy(alpha = 0.75f))
            .border(1.dp, if (a.read) Tac.HairlineDim else Tac.Amber.copy(alpha = 0.35f), RoundedCornerShape(3.dp))
            .clickable(onClick = onClick)
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(54.dp).background(if (a.read) Tac.HairlineDim else Tac.Amber))
        Spacer(Modifier.width(10.dp))
        EventImage(a.eventId, a.imageUrl, Modifier.size(width = 96.dp, height = 54.dp).clip(RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Chip(Fmt.kind(a.kind), c, filled = !a.read)
                if (!a.read) Text("NEW", style = Tac.DataSmall.copy(color = Tac.Amber))
            }
            Spacer(Modifier.height(4.dp))
            Text(a.cameraName.uppercase(), style = Tac.Data.copy(color = if (a.read) Tac.TextDim else Tac.Text), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${a.label} ${Fmt.pct(a.confidence)}", style = Tac.DataSmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(Fmt.clock(a.createdAt), style = Tac.Data.copy(color = Tac.TextDim))
            Text(Fmt.ago(a.createdAt), style = Tac.DataSmall.copy(color = Tac.TextFaint))
        }
    }
}

/** Detection event: captured frame, metadata, jump to live. Opening it sends the read receipt. */
@Composable
fun EventDetailScreen(repo: Repository, eventId: String, alertId: String?, onBack: () -> Unit, onLive: (String) -> Unit) {
    var ev by remember { mutableStateOf<DetectionEventItem?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val alert = alertId?.let { repo.alerts.get(it) }

    LaunchedEffect(eventId) {
        runCatching { repo.api.event(eventId) }.onSuccess { ev = it }.onFailure { error = it.message }
    }
    LaunchedEffect(alertId) { alertId?.let { repo.markRead(listOf(it)) } }

    val kind = ev?.kind ?: alert?.kind ?: ""
    val c = Tac.kindColor(kind)
    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar("${Fmt.kind(kind)} DETECTED", subtitle = (ev?.cameraName ?: alert?.cameraName ?: "").uppercase(), onBack = onBack)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(14.dp)) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(3.dp)).cornerBrackets(c, 18.dp, 2.dp, 6.dp)) {
                    EventImage(eventId, ev?.imageUrl ?: alert?.imageUrl, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                }
                Spacer(Modifier.height(14.dp))
                GlassPanel(Modifier.fillMaxWidth(), accent = c.copy(alpha = 0.6f)) {
                    Text("// TARGET", style = Tac.Label.copy(color = c))
                    Spacer(Modifier.height(6.dp))
                    val e = ev
                    if (e != null) {
                        KeyValue("Class", "${Fmt.kind(e.kind)} (${e.label})", c)
                        KeyValue("Confidence", Fmt.pct(e.confidence))
                        KeyValue("Track", e.trackId?.let { "#$it" } ?: "—")
                        KeyValue("Camera", e.cameraName)
                        KeyValue("Time", Fmt.stamp(e.createdAt))
                        KeyValue("Age", Fmt.ago(e.createdAt))
                        KeyValue("Event", e.id.take(8).uppercase())
                    } else {
                        Text(error ?: "Loading…", style = Tac.DataSmall)
                    }
                }
                Spacer(Modifier.height(14.dp))
                val camId = ev?.cameraId ?: alert?.cameraId
                if (camId != null) TacButton("Go live ›", { onLive(camId) }, primary = true, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
