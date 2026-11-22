package com.tactical.seccam.data

import org.json.JSONArray
import org.json.JSONObject

data class ListenerSettings(
    val kind: String,
    val label: String,
    val enabled: Boolean,
    val notify: Boolean,
    val minConfidence: Double,
    val cooldownSec: Int,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("kind", kind).put("enabled", enabled).put("notify", notify)
        .put("minConfidence", minConfidence).put("cooldownSec", cooldownSec)

    companion object {
        fun from(o: JSONObject) = ListenerSettings(
            kind = o.getString("kind"),
            label = o.optString("label", o.getString("kind")),
            enabled = o.optBoolean("enabled"),
            notify = o.optBoolean("notify", true),
            minConfidence = o.optDouble("minConfidence", 0.5),
            cooldownSec = o.optInt("cooldownSec", 10),
        )
    }
}

data class CameraStatus(
    val stream: String = "connecting",
    val detector: String = "off",
    val tracks: List<String> = emptyList(),
    val readers: Int = 0,
    val since: Long = 0,
    val message: String? = null,
) {
    val online get() = stream == "online"

    companion object {
        fun from(o: JSONObject?) = if (o == null) CameraStatus() else CameraStatus(
            stream = o.optString("stream", "connecting"),
            detector = o.optString("detector", "off"),
            tracks = o.optJSONArray("tracks").strings(),
            readers = o.optInt("readers"),
            since = o.optLong("since"),
            message = o.optString("message").ifBlank { null },
        )
    }
}

data class Camera(
    val id: String,
    val name: String,
    val rtspUrl: String,
    val hasCredentials: Boolean,
    val transport: String,
    val enabled: Boolean,
    val notificationsEnabled: Boolean,
    val listeners: List<ListenerSettings>,
    val status: CameraStatus,
    val createdAt: Long,
) {
    companion object {
        fun from(o: JSONObject) = Camera(
            id = o.getString("id"),
            name = o.getString("name"),
            rtspUrl = o.optString("rtspUrl"),
            hasCredentials = o.optBoolean("hasCredentials"),
            transport = o.optString("transport", "automatic"),
            enabled = o.optBoolean("enabled", true),
            notificationsEnabled = o.optBoolean("notificationsEnabled", true),
            listeners = o.optJSONArray("listeners").objects().map(ListenerSettings::from),
            status = CameraStatus.from(o.optJSONObject("status")),
            createdAt = o.optLong("createdAt"),
        )
    }
}

/** A detection notification. `id` is the server's notification id and the de-duplication key. */
data class AlertItem(
    val id: String,
    val eventId: String,
    val cameraId: String,
    val cameraName: String,
    val kind: String,
    val label: String,
    val confidence: Double,
    val title: String,
    val body: String,
    val createdAt: Long,
    val imageUrl: String?,
    val read: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("eventId", eventId).put("cameraId", cameraId).put("cameraName", cameraName)
        .put("kind", kind).put("label", label).put("confidence", confidence).put("title", title)
        .put("body", body).put("createdAt", createdAt).put("imageUrl", imageUrl ?: JSONObject.NULL)
        .put("read", read)

    companion object {
        fun from(o: JSONObject, readOverride: Boolean? = null) = AlertItem(
            id = o.getString("id"),
            eventId = o.getString("eventId"),
            cameraId = o.getString("cameraId"),
            cameraName = o.optString("cameraName", "Camera"),
            kind = o.optString("kind"),
            label = o.optString("label"),
            confidence = o.optDouble("confidence"),
            title = o.optString("title"),
            body = o.optString("body"),
            createdAt = o.optLong("createdAt"),
            imageUrl = o.optString("imageUrl").takeIf { it.isNotBlank() && it != "null" },
            read = readOverride ?: (o.optBoolean("read") || o.optString("state") == "read"),
        )
    }
}

data class DetectionEventItem(
    val id: String,
    val cameraId: String,
    val cameraName: String,
    val kind: String,
    val label: String,
    val confidence: Double,
    val trackId: Int?,
    val createdAt: Long,
    val imageUrl: String?,
    /** "recording", "ready", "failed", or null when the event has no clip. */
    val clipState: String?,
    /** Signed, expiring URL; set only when the clip is ready. */
    val clipUrl: String?,
    val clipDurationSec: Double?,
) {
    companion object {
        fun from(o: JSONObject) = DetectionEventItem(
            id = o.getString("id"),
            cameraId = o.getString("cameraId"),
            cameraName = o.optString("cameraName", "Camera"),
            kind = o.optString("kind"),
            label = o.optString("label"),
            confidence = o.optDouble("confidence"),
            trackId = if (o.isNull("trackId")) null else o.optInt("trackId"),
            createdAt = o.optLong("createdAt"),
            imageUrl = o.optString("imageUrl").takeIf { it.isNotBlank() && it != "null" },
            clipState = o.optString("clipState").takeIf { it.isNotBlank() && it != "null" },
            clipUrl = o.optString("clipUrl").takeIf { it.isNotBlank() && it != "null" },
            clipDurationSec = if (o.isNull("clipDurationSec")) null else o.optDouble("clipDurationSec"),
        )
    }
}

data class ProbeResult(val ok: Boolean, val error: String?, val summary: String?, val latencyMs: Long) {
    companion object {
        fun from(o: JSONObject): ProbeResult {
            val v = o.optJSONObject("video")
            val summary = v?.let { "${it.optString("codec").uppercase()} ${it.optInt("width")}x${it.optInt("height")}" + (if (it.has("fps")) " @${it.optDouble("fps")}fps" else "") }
            return ProbeResult(o.optBoolean("ok"), o.optString("error").ifBlank { null }, summary, o.optLong("latencyMs"))
        }
    }
}

/** One entry in the list event detail pages through. */
data class EventRef(val eventId: String, val alertId: String? = null)

data class StreamTicket(val url: String, val expiresInSec: Int)

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
