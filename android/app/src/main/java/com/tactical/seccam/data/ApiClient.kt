package com.tactical.seccam.data

import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : Exception(message)

/** REST client for the security camera server. Refreshes the access token transparently. */
class ApiClient(private val session: Session) {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val json = "application/json".toMediaType()
    private val refreshLock = Mutex()

    fun absolute(path: String) = if (path.startsWith("http")) path else session.serverUrl + path

    // ---- auth -----------------------------------------------------------------

    suspend fun health(server: String): JSONObject = withContext(Dispatchers.IO) {
        val r = http.newCall(Request.Builder().url("${server.trimEnd('/')}/api/health").build()).execute()
        r.use { if (!it.isSuccessful) throw ApiException(it.code, "server returned ${it.code}"); JSONObject(it.body!!.string()) }
    }

    suspend fun setup(server: String, username: String, password: String) {
        raw("POST", "${server.trimEnd('/')}/api/setup", JSONObject().put("username", username).put("password", password), auth = false)
    }

    suspend fun login(server: String, username: String, password: String) {
        val body = JSONObject()
            .put("username", username).put("password", password)
            .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".take(64))
            .put("platform", "android")
        session.deviceId?.let { body.put("deviceId", it) }
        val r = JSONObject(raw("POST", "${server.trimEnd('/')}/api/auth/login", body, auth = false))
        session.serverUrl = server
        session.username = username
        storeTokens(r)
    }

    private fun storeTokens(r: JSONObject) {
        session.accessToken = r.getString("accessToken")
        session.refreshToken = r.getString("refreshToken")
        session.deviceId = r.getString("deviceId")
    }

    /** Returns a valid access token, refreshing if needed. */
    suspend fun accessToken(forceRefresh: Boolean = false): String = refreshLock.withLock {
        val current = session.accessToken
        if (!forceRefresh && current != null && !expiringSoon(current)) return current
        val refresh = session.refreshToken ?: throw ApiException(401, "signed out")
        val r = JSONObject(raw("POST", "${session.serverUrl}/api/auth/refresh", JSONObject().put("refreshToken", refresh), auth = false))
        storeTokens(r)
        return session.accessToken!!
    }

    private fun expiringSoon(jwt: String): Boolean = try {
        val payload = String(android.util.Base64.decode(jwt.split(".")[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
        JSONObject(payload).getLong("exp") * 1000 - System.currentTimeMillis() < 60_000
    } catch (_: Exception) {
        true
    }

    // ---- resources --------------------------------------------------------------

    suspend fun bootstrap() = JSONObject(call("GET", "/api/bootstrap"))
    suspend fun cameras() = JSONArray(call("GET", "/api/cameras")).objects().map(Camera::from)
    suspend fun camera(id: String) = Camera.from(JSONObject(call("GET", "/api/cameras/$id")))

    suspend fun testCamera(url: String, user: String?, pass: String?, transport: String) = ProbeResult.from(
        JSONObject(call("POST", "/api/cameras/test", JSONObject().put("rtspUrl", url).put("username", user.orNull()).put("password", pass.orNull()).put("transport", transport))),
    )

    suspend fun retestCamera(id: String) = ProbeResult.from(JSONObject(call("POST", "/api/cameras/$id/test", JSONObject())))

    suspend fun createCamera(name: String, url: String, user: String?, pass: String?, transport: String): Camera = Camera.from(
        JSONObject(call("POST", "/api/cameras", JSONObject().put("name", name).put("rtspUrl", url).put("username", user.orNull()).put("password", pass.orNull()).put("transport", transport).put("skipTest", true))),
    )

    suspend fun updateCamera(id: String, patch: JSONObject) = Camera.from(JSONObject(call("PATCH", "/api/cameras/$id", patch)))
    suspend fun deleteCamera(id: String) { call("DELETE", "/api/cameras/$id") }

    suspend fun updateSettings(id: String, notificationsEnabled: Boolean?, listeners: List<ListenerSettings>?) {
        val body = JSONObject()
        notificationsEnabled?.let { body.put("notificationsEnabled", it) }
        listeners?.let { body.put("listeners", JSONArray(it.map(ListenerSettings::toJson))) }
        call("PUT", "/api/cameras/$id/settings", body)
    }

    suspend fun streamTicket(id: String): StreamTicket {
        val o = JSONObject(call("POST", "/api/cameras/$id/stream-token", JSONObject()))
        return StreamTicket(o.getString("url"), o.optInt("expiresInSec", 600))
    }

    suspend fun events(cameraId: String? = null, before: Long? = null, limit: Int = 50): List<DetectionEventItem> {
        val q = buildList {
            cameraId?.let { add("cameraId=$it") }
            before?.let { add("before=$it") }
            add("limit=$limit")
        }.joinToString("&")
        return JSONArray(call("GET", "/api/events?$q")).objects().map(DetectionEventItem::from)
    }

    suspend fun event(id: String) = DetectionEventItem.from(JSONObject(call("GET", "/api/events/$id")))

    /** Deletes events (frames, notifications and deliveries go with them). Returns (eventIds, notificationIds). */
    suspend fun deleteEvents(ids: List<String>): Pair<List<String>, List<String>> {
        val o = JSONObject(call("POST", "/api/events/delete", JSONObject().put("ids", JSONArray(ids))))
        return o.optJSONArray("eventIds").strings() to o.optJSONArray("notificationIds").strings()
    }

    suspend fun notifications(limit: Int = 100) = JSONArray(call("GET", "/api/notifications?limit=$limit")).objects().map { AlertItem.from(it) }

    suspend fun ackRest(ids: List<String>) { call("POST", "/api/notifications/ack", JSONObject().put("ids", JSONArray(ids))) }
    suspend fun readRest(ids: List<String>) { call("POST", "/api/notifications/read", JSONObject().put("ids", JSONArray(ids))) }

    // ---- transport -------------------------------------------------------------

    private suspend fun call(method: String, path: String, body: JSONObject? = null): String {
        val url = session.serverUrl + path
        return try {
            raw(method, url, body, token = accessToken())
        } catch (e: ApiException) {
            if (e.status != 401) throw e
            raw(method, url, body, token = accessToken(forceRefresh = true))
        }
    }

    private suspend fun raw(method: String, url: String, body: JSONObject?, auth: Boolean = true, token: String? = null): String = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(url)
        if (auth && token != null) b.header("Authorization", "Bearer $token")
        val rb = body?.toString()?.toRequestBody(json)
        b.method(method, if (method == "GET") null else rb ?: "{}".toRequestBody(json))
        http.newCall(b.build()).execute().use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()?.ifBlank { null } ?: "HTTP ${r.code}"
                throw ApiException(r.code, msg)
            }
            text
        }
    }

    private fun String?.orNull(): Any = if (this.isNullOrBlank()) JSONObject.NULL else this
}
