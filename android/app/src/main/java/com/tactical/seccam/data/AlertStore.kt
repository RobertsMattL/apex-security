package com.tactical.seccam.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import java.io.File

/**
 * Local notification inbox, keyed by the server's notification id.
 *
 * The server re-sends a notification until it sees our ack, and flushes everything
 * un-acked when we reconnect, so the same id can arrive several times. Keying on the id
 * makes every delivery after the first a no-op: the UI never shows duplicates.
 * Persisted to app storage so the inbox (and read state) survives process death.
 */
class AlertStore(context: Context) {
    private val file = File(context.filesDir, "alerts.json")
    private val items = LinkedHashMap<String, AlertItem>()
    private val _alerts = MutableStateFlow<List<AlertItem>>(emptyList())
    val alerts: StateFlow<List<AlertItem>> = _alerts.asStateFlow()

    init {
        runCatching {
            if (file.exists()) JSONArray(file.readText()).objects().map { AlertItem.from(it) }.forEach { items[it.id] = it }
        }
        publish(persist = false)
    }

    /** Returns true if this id was not seen before. */
    @Synchronized
    fun upsert(a: AlertItem): Boolean {
        val existing = items[a.id]
        // Keep local read state (a read can happen before a redelivery arrives).
        items[a.id] = if (existing != null) a.copy(read = existing.read || a.read) else a
        publish()
        return existing == null
    }

    @Synchronized
    fun merge(list: List<AlertItem>) {
        for (a in list) {
            val existing = items[a.id]
            items[a.id] = if (existing != null) a.copy(read = existing.read || a.read) else a
        }
        publish()
    }

    @Synchronized
    fun markRead(ids: Collection<String>) {
        var changed = false
        for (id in ids) items[id]?.takeIf { !it.read }?.let { items[id] = it.copy(read = true); changed = true }
        if (changed) publish()
    }

    /** Drop notifications by id or by the event they belong to (events were deleted). */
    @Synchronized
    fun removeEvents(eventIds: Collection<String>, notificationIds: Collection<String>) {
        val ev = eventIds.toSet(); val nid = notificationIds.toSet()
        if (items.values.removeAll { it.eventId in ev || it.id in nid }) publish()
    }

    @Synchronized
    fun removeCamera(cameraId: String) {
        items.values.removeAll { it.cameraId == cameraId }
        publish()
    }

    @Synchronized
    fun clear() {
        items.clear()
        publish()
    }

    fun get(id: String) = items[id]

    private fun publish(persist: Boolean = true) {
        val sorted = items.values.sortedByDescending { it.createdAt }.take(MAX)
        if (items.size > MAX) {
            val keep = sorted.map { it.id }.toSet()
            items.keys.retainAll(keep)
        }
        _alerts.value = sorted
        if (persist) runCatching {
            val tmp = File(file.parentFile, "alerts.json.tmp")
            tmp.writeText(JSONArray(sorted.map(AlertItem::toJson)).toString())
            tmp.renameTo(file)
        }
    }

    companion object {
        const val MAX = 500
    }
}
