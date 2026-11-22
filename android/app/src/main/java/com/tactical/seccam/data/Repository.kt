package com.tactical.seccam.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.tactical.seccam.service.ConnectionService
import com.tactical.seccam.service.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * App-wide state and the single owner of the server connection.
 * Screens observe the flows; the realtime client feeds them.
 */
class Repository(private val context: Context) {
    val session = Session(context)
    val api = ApiClient(session)
    val alerts = AlertStore(context)
    private val notifier = Notifier(context, api)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _cameras = MutableStateFlow<List<Camera>>(emptyList())
    val cameras: StateFlow<List<Camera>> = _cameras.asStateFlow()

    /** Latest detection events across all cameras (activity feed), newest first. */
    private val _activity = MutableStateFlow<List<DetectionEventItem>>(emptyList())
    val activity: StateFlow<List<DetectionEventItem>> = _activity.asStateFlow()

    private val _signedIn = MutableStateFlow(session.signedIn)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /** Bumped when a camera's event history should be re-fetched. */
    private val _eventsVersion = MutableStateFlow(0L)
    val eventsVersion: StateFlow<Long> = _eventsVersion.asStateFlow()

    /** Latest "clip finished" signal (event id, state); event detail re-fetches to get the playable URL. */
    private val _clipUpdate = MutableStateFlow<Pair<String, String>?>(null)
    val clipUpdate: StateFlow<Pair<String, String>?> = _clipUpdate.asStateFlow()

    /** The list the user opened an event from; event detail swipes through it. */
    private val _eventSequence = MutableStateFlow<List<EventRef>>(emptyList())
    val eventSequence: StateFlow<List<EventRef>> = _eventSequence.asStateFlow()
    fun setEventSequence(list: List<EventRef>) { _eventSequence.value = list }

    val realtime = RealtimeClient(api, session, scope, ::onMessage, onConnected = { scope.launch { refresh() } })
    val link get() = realtime.state

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = realtime.nudge()
        })
    }

    fun startIfSignedIn() {
        if (!session.signedIn) return
        _signedIn.value = true
        realtime.start()
        ConnectionService.start(context)
    }

    suspend fun signIn(server: String, username: String, password: String, createAccount: Boolean) {
        val url = server.trim().trimEnd('/').let { if (it.startsWith("http")) it else "http://$it" }
        if (createAccount) api.setup(url, username, password)
        api.login(url, username, password)
        alerts.clear()
        startIfSignedIn()
    }

    fun signOut() {
        realtime.stop()
        ConnectionService.stop(context)
        session.clearTokens()
        alerts.clear()
        _cameras.value = emptyList()
        _activity.value = emptyList()
        _signedIn.value = false
    }

    /** Full resync after (re)connecting: cameras, inbox, recent activity. */
    suspend fun refresh() {
        try {
            val b = api.bootstrap()
            _cameras.value = b.optJSONArray("cameras").objects().map(Camera::from)
            alerts.merge(b.optJSONArray("notifications").objects().map { AlertItem.from(it) })
            _activity.value = api.events(limit = 30)
            _lastError.value = null
        } catch (e: ApiException) {
            if (e.status == 401) signOut() else _lastError.value = e.message
        } catch (e: Exception) {
            _lastError.value = e.message
        }
    }

    fun camera(id: String) = _cameras.value.firstOrNull { it.id == id }

    fun upsertCamera(c: Camera) = _cameras.update { list -> if (list.any { it.id == c.id }) list.map { if (it.id == c.id) c else it } else list + c }

    fun removeCameraLocal(id: String) {
        _cameras.update { list -> list.filterNot { it.id == id } }
        alerts.removeCamera(id)
    }

    /** User viewed these notifications: read receipt to the server (socket, REST fallback). */
    fun markRead(ids: List<String>) {
        val unread = ids.filter { alerts.get(it)?.read == false }
        if (unread.isEmpty()) return
        alerts.markRead(unread)
        unread.forEach(notifier::cancel)
        if (!realtime.read(unread)) scope.launch { runCatching { api.readRest(unread) } }
    }

    fun markAllRead() = markRead(alerts.alerts.value.filter { !it.read }.map { it.id })

    /** Delete events everywhere; applied locally at once, the server tells other devices. */
    suspend fun deleteEvents(eventIds: List<String>) {
        if (eventIds.isEmpty()) return
        val (ev, notes) = api.deleteEvents(eventIds)
        applyDeleted(ev, notes)
    }

    private fun applyDeleted(eventIds: List<String>, notificationIds: List<String>) {
        val gone = eventIds.toSet()
        alerts.alerts.value.filter { it.eventId in gone || it.id in notificationIds }.forEach { notifier.cancel(it.id) }
        alerts.removeEvents(eventIds, notificationIds)
        _activity.update { list -> list.filterNot { it.id in gone } }
        _eventSequence.update { list -> list.filterNot { it.eventId in gone } }
        _eventsVersion.value = System.currentTimeMillis()
    }

    private fun onMessage(m: JSONObject) {
        when (m.optString("t")) {
            "notification" -> {
                val n = AlertItem.from(m.getJSONObject("n"))
                // Persist first, then acknowledge receipt: an ack means we really have it.
                val isNew = alerts.upsert(n)
                realtime.ack(listOf(n.id))
                if (isNew && !n.read) notifier.show(n)
            }
            "notification.read" -> {
                val id = m.getString("id")
                alerts.markRead(listOf(id))
                notifier.cancel(id)
            }
            "camera.status" -> {
                val id = m.getString("cameraId")
                val st = CameraStatus.from(m.getJSONObject("status"))
                _cameras.update { list -> list.map { if (it.id == id) it.copy(status = st) else it } }
            }
            "camera.upserted" -> upsertCamera(Camera.from(m.getJSONObject("camera")))
            "camera.removed" -> removeCameraLocal(m.getString("cameraId"))
            "settings.updated" -> {
                val id = m.getString("cameraId")
                val s = m.getJSONObject("settings")
                val listeners = s.optJSONArray("listeners").objects().map(ListenerSettings::from)
                _cameras.update { list -> list.map { if (it.id == id) it.copy(notificationsEnabled = s.optBoolean("notificationsEnabled", it.notificationsEnabled), listeners = listeners) else it } }
            }
            "event" -> scope.launch {
                runCatching { api.event(m.getJSONObject("event").getString("id")) }.onSuccess { ev ->
                    _activity.update { (listOf(ev) + it.filterNot { x -> x.id == ev.id }).take(50) }
                    _eventsVersion.value = System.currentTimeMillis()
                }
            }
            "event.clip" -> _clipUpdate.value = m.getString("id") to m.optString("clipState")
            "events.deleted" -> applyDeleted(m.optJSONArray("eventIds").strings(), m.optJSONArray("notificationIds").strings())
            "welcome", "pong", "ack.ok", "read.ok" -> Unit
            "error" -> Log.w("Repository", "server error: ${m.optString("error")}")
        }
    }
}
