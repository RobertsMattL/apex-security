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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.AlertItem
import com.tactical.seccam.data.DetectionEventItem
import com.tactical.seccam.data.EventRef
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.Chip
import com.tactical.seccam.ui.components.ClipControls
import com.tactical.seccam.ui.components.ClipPlayer
import com.tactical.seccam.ui.components.rememberClipState
import com.tactical.seccam.ui.components.Segmented
import com.tactical.seccam.ui.components.StatusPip
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
import com.tactical.seccam.ui.components.ZoomBadge
import com.tactical.seccam.ui.components.pinchZoomInput
import com.tactical.seccam.ui.components.rememberZoomState
import com.tactical.seccam.ui.components.shareEventMedia
import androidx.compose.ui.platform.LocalContext
import com.tactical.seccam.ui.theme.Tac

/** Notification center: inbox grouped by day, filterable by unread / camera. */
@Composable
fun AlertsScreen(repo: Repository, onBack: () -> Unit, onOpen: (AlertItem) -> Unit) {
    val alerts by repo.alerts.alerts.collectAsStateWithLifecycle()
    val cameras by repo.cameras.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf("all") } // all | unread | camera id
    var selecting by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
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
                if (unread > 0 && !selecting) TacButton("Read all", { repo.markAllRead() }, accent = Tac.Amber)
                if (alerts.isNotEmpty()) TacButton(if (selecting) "Done" else "Select", { selecting = !selecting; selected = emptySet(); confirming = false }, accent = if (selecting) Tac.Cyan else Tac.TextDim)
            }
            if (selecting) {
                val live = selected.filter { id -> shown.any { it.id == id } }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).clip(RoundedCornerShape(3.dp)).border(1.dp, Tac.Cyan.copy(alpha = 0.35f), RoundedCornerShape(3.dp)).background(Tac.Void.copy(alpha = 0.9f)).padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("${live.size} SELECTED", style = Tac.Data.copy(color = Tac.Cyan), modifier = Modifier.weight(1f))
                    if (live.size < shown.size) TacButton("All", { selected = shown.map { it.id }.toSet(); confirming = false })
                    TacButton(
                        if (busy) "…" else if (confirming) "Confirm ${live.size}" else "Delete",
                        {
                            if (!confirming) confirming = true
                            else scope.launch {
                                busy = true
                                runCatching { repo.deleteEvents(shown.filter { it.id in selected }.map { it.eventId }) }
                                    .onSuccess { selected = emptySet(); selecting = false; error = null }
                                    .onFailure { error = it.message }
                                busy = false; confirming = false
                            }
                        },
                        accent = Tac.Red, primary = confirming, enabled = live.isNotEmpty() && !busy,
                    )
                }
            }
            error?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.Red), modifier = Modifier.padding(horizontal = 14.dp)) }
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
                        items(list, key = { it.id }) { a ->
                            AlertRow(a, selecting = selecting, selected = a.id in selected) {
                                if (selecting) { selected = if (a.id in selected) selected - a.id else selected + a.id; confirming = false } else { repo.setEventSequence(shown.map { EventRef(it.eventId, it.id) }); onOpen(a) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AlertRow(a: AlertItem, selecting: Boolean = false, selected: Boolean = false, onClick: () -> Unit) {
    val c = Tac.kindColor(a.kind)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(3.dp))
            .background(if (a.read) Tac.Charcoal.copy(alpha = 0.35f) else Tac.Raised.copy(alpha = 0.75f))
            .border(1.dp, if (selected) Tac.Cyan.copy(alpha = 0.6f) else if (a.read) Tac.HairlineDim else Tac.Amber.copy(alpha = 0.35f), RoundedCornerShape(3.dp))
            .clickable(onClick = onClick)
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selecting) {
            Box(Modifier.size(18.dp).border(1.dp, if (selected) Tac.Cyan else Tac.TextFaint, RoundedCornerShape(2.dp)), contentAlignment = Alignment.Center) {
                if (selected) Box(Modifier.size(8.dp).background(Tac.Cyan))
            }
            Spacer(Modifier.width(10.dp))
        }
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

/**
 * Detection event detail. Swipe left/right to move through the list it was opened from
 * (alerts, a camera's detections, recent activity). Each viewed alert gets its read receipt.
 */
@Composable
fun EventDetailScreen(repo: Repository, eventId: String, alertId: String?, onBack: () -> Unit, onLive: (String) -> Unit) {
    val seq by repo.eventSequence.collectAsStateWithLifecycle()
    val alerts by repo.alerts.alerts.collectAsStateWithLifecycle()
    // Page through the originating list if this event is in it; otherwise just this one event.
    val opened = remember { EventRef(eventId, alertId) }
    val items = remember(seq) { if (seq.any { it.eventId == opened.eventId }) seq else listOf(opened) }
    val pager = rememberPagerState(initialPage = items.indexOfFirst { it.eventId == opened.eventId }.coerceAtLeast(0)) { items.size }
    val cache = remember { mutableStateMapOf<String, DetectionEventItem>() }
    var deletedSingle by remember { mutableStateOf(false) }
    val navScope = rememberCoroutineScope()

    LaunchedEffect(pager.settledPage, items) { items.getOrNull(pager.settledPage)?.alertId?.let { repo.markRead(listOf(it)) } }
    // The opened event was deleted and there is nothing left to show.
    LaunchedEffect(items.isEmpty(), deletedSingle) { if (items.isEmpty() || deletedSingle) onBack() }
    if (items.isEmpty()) return

    val cur = items[pager.currentPage.coerceIn(0, items.lastIndex)]
    val curAlert = cur.alertId?.let { id -> alerts.firstOrNull { it.id == id } }
    val curEv = cache[cur.eventId]
    val kind = curEv?.kind ?: curAlert?.kind ?: ""
    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar(
                "${Fmt.kind(kind)} DETECTED",
                subtitle = listOfNotNull((curEv?.cameraName ?: curAlert?.cameraName)?.uppercase(), if (items.size > 1) "${pager.currentPage + 1} / ${items.size}" else null).joinToString(" · "),
                onBack = onBack,
            ) {
                if (items.size > 1) Text("‹ SWIPE ›", style = Tac.DataSmall.copy(color = Tac.TextFaint))
            }
            HorizontalPager(pager, key = { items[it].eventId }, beyondViewportPageCount = 1, modifier = Modifier.fillMaxSize()) { page ->
                EventPage(
                    repo, items[page], cache, active = page == pager.settledPage, onLive,
                    onDeleted = { if (items.size <= 1) deletedSingle = true },
                    onPrev = if (page > 0) ({ navScope.launch { pager.animateScrollToPage(page - 1) } }) else null,
                    onNext = if (page < items.lastIndex) ({ navScope.launch { pager.animateScrollToPage(page + 1) } }) else null,
                )
            }
        }
    }
}

@Composable
private fun EventPage(repo: Repository, ref: EventRef, cache: MutableMap<String, DetectionEventItem>, active: Boolean, onLive: (String) -> Unit, onDeleted: () -> Unit, onPrev: (() -> Unit)? = null, onNext: (() -> Unit)? = null) {
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showFrame by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val alert = ref.alertId?.let { repo.alerts.get(it) }
    val clipUpdate by repo.clipUpdate.collectAsStateWithLifecycle()
    LaunchedEffect(ref.eventId) {
        if (cache[ref.eventId] == null) runCatching { repo.api.event(ref.eventId) }.onSuccess { cache[ref.eventId] = it }.onFailure { error = it.message }
    }
    // The clip finished recording while we're looking: fetch the playable URL.
    LaunchedEffect(clipUpdate) {
        val (id, state) = clipUpdate ?: return@LaunchedEffect
        if (id == ref.eventId && cache[id]?.clipState != state) runCatching { repo.api.event(id) }.onSuccess { cache[id] = it }
    }
    val ev = cache[ref.eventId]
    val c = Tac.kindColor(ev?.kind ?: alert?.kind ?: "")
    val clipUrl = ev?.clipUrl
    val context = LocalContext.current
    var sharing by remember { mutableStateOf(false) }
    var shareError by remember { mutableStateOf<String?>(null) }
    // Zoom is per media view; leaving the page or switching clip/frame starts back at 1x.
    val zoom = rememberZoomState(ref.eventId, showFrame, clipUrl != null)
    LaunchedEffect(active) { if (!active) zoom.reset() }
    val clip = if (clipUrl != null && !showFrame) rememberClipState(ref.eventId, clipUrl, active) else null
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(14.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(3.dp)).cornerBrackets(c, 18.dp, 2.dp, 6.dp).pinchZoomInput(zoom)) {
            if (clip != null) {
                ClipPlayer(clip, modifier = Modifier.fillMaxSize(), zoom = zoom)
            } else {
                EventImage(ref.eventId, ev?.imageUrl ?: alert?.imageUrl, Modifier.fillMaxSize(), contentScale = ContentScale.Fit, zoom = zoom)
                val badge = when (ev?.clipState) { "recording" -> "REC · CLIP RECORDING"; "failed" -> "CLIP UNAVAILABLE"; else -> if (clipUrl != null) "DETECTION FRAME" else null }
                if (badge != null) Row(
                    Modifier.align(Alignment.TopStart).padding(10.dp).background(Tac.Void.copy(alpha = 0.72f), RoundedCornerShape(2.dp))
                        .border(1.dp, if (ev?.clipState == "recording") Tac.Red.copy(alpha = 0.45f) else Tac.Hairline, RoundedCornerShape(2.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (ev?.clipState == "recording") { StatusPip(Tac.Red, pulse = true, size = 6.dp); Spacer(Modifier.width(6.dp)) }
                    Text(badge, style = Tac.DataSmall.copy(color = if (ev?.clipState == "recording") Tac.Red else Tac.TextDim))
                }
            }
            onPrev?.let { NavArrow("‹", Modifier.align(Alignment.CenterStart).padding(start = 8.dp), it) }
            onNext?.let { NavArrow("›", Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), it) }
            ZoomBadge(zoom, Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp))
        }
        if (clip != null) {
            Spacer(Modifier.height(6.dp))
            ClipControls(clip)
        }
        if (clipUrl != null) {
            Spacer(Modifier.height(10.dp))
            Segmented(listOf("clip" to "▶ CLIP ${Fmt.secs(ev.clipDurationSec)}", "frame" to "DETECTION FRAME"), if (showFrame) "frame" else "clip") { showFrame = it == "frame" }
        }
        Spacer(Modifier.height(14.dp))
        GlassPanel(Modifier.fillMaxWidth(), accent = c.copy(alpha = 0.6f)) {
            Text("// TARGET", style = Tac.Label.copy(color = c))
            Spacer(Modifier.height(6.dp))
            if (ev != null) {
                KeyValue("Class", "${Fmt.kind(ev.kind)} (${ev.label})", c)
                KeyValue("Confidence", Fmt.pct(ev.confidence))
                KeyValue("Track", ev.trackId?.let { "#$it" } ?: "—")
                KeyValue(
                    "Clip",
                    when (ev.clipState) { "ready" -> Fmt.secs(ev.clipDurationSec); "recording" -> "RECORDING…"; "failed" -> "FAILED"; else -> "NONE" },
                    if (ev.clipState == "recording") Tac.Red else Tac.Text,
                )
                KeyValue("Camera", ev.cameraName)
                KeyValue("Time", Fmt.stamp(ev.createdAt))
                KeyValue("Age", Fmt.ago(ev.createdAt))
                KeyValue("Event", ev.id.take(8).uppercase())
            } else {
                Text(error ?: "Loading…", style = Tac.DataSmall)
            }
        }
        Spacer(Modifier.height(14.dp))
        val camId = ev?.cameraId ?: alert?.cameraId
        if (camId != null) TacButton("Go live ›", { onLive(camId) }, primary = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        if (ev != null && (ev.clipUrl != null || ev.imageUrl != null)) {
            // Shares what is on screen: the clip, or the frame when that tab is selected or there is no clip.
            val shareClip = ev.clipUrl != null && !showFrame
            TacButton(
                when { sharing -> "Preparing…"; shareClip -> "Share clip ⇪"; else -> "Share frame ⇪" },
                {
                    if (!sharing) scope.launch {
                        sharing = true; shareError = null
                        runCatching { shareEventMedia(context, repo, ev, shareClip) }.onFailure { shareError = "Share failed: ${it.message}" }
                        sharing = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            shareError?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.Red), modifier = Modifier.padding(top = 6.dp)) }
            Spacer(Modifier.height(10.dp))
        }
        TacButton(
            if (confirmDelete) "Confirm delete event" else "Delete event",
            {
                if (!confirmDelete) confirmDelete = true
                else scope.launch { runCatching { repo.deleteEvents(listOf(ref.eventId)) }.onSuccess { onDeleted() }.onFailure { error = it.message; confirmDelete = false } }
            },
            accent = Tac.Red, primary = confirmDelete, modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Big previous / next event arrow over the event media. */
@Composable
private fun NavArrow(glyph: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .size(width = 48.dp, height = 84.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(Tac.Void.copy(alpha = 0.6f))
            .border(1.dp, Tac.Cyan.copy(alpha = 0.45f), RoundedCornerShape(3.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = Tac.Title.copy(color = Tac.Cyan, fontSize = 52.sp, lineHeight = 52.sp, fontWeight = FontWeight.Light))
    }
}
