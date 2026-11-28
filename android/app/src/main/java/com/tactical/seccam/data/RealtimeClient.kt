package com.tactical.seccam.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min

enum class LinkState { OFFLINE, CONNECTING, ONLINE }

/**
 * Persistent WebSocket to the server's gateway.
 *  - reconnects with exponential backoff (1 s .. 30 s), refreshing the token when rejected
 *  - app-level heartbeat: ping every 20 s; if nothing arrives for 50 s the link is
 *    considered dead and is rebuilt (catches half-open TCP after network changes)
 *  - messages are handed to [onMessage] on the IO thread, in order
 */
class RealtimeClient(
    private val api: ApiClient,
    private val session: Session,
    private val scope: CoroutineScope,
    private val onMessage: (JSONObject) -> Unit,
    private val onConnected: () -> Unit,
    /** The server rejected our refresh token: the session is dead and the user must sign in again. */
    private val onAuthRejected: () -> Unit,
) {
    private val _state = MutableStateFlow(LinkState.OFFLINE)
    val state: StateFlow<LinkState> = _state.asStateFlow()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var lastMessageAt = 0L
    private var attempt = 0
    private var loop: Job? = null
    private var heartbeat: Job? = null
    @Volatile private var wanted = false

    fun start() {
        if (wanted) return
        wanted = true
        connect()
        heartbeat = scope.launch {
            while (isActive) {
                delay(20_000)
                val s = socket ?: continue
                s.send("""{"t":"ping"}""")
                if (_state.value == LinkState.ONLINE && System.currentTimeMillis() - lastMessageAt > 50_000) {
                    Log.w(TAG, "heartbeat lost; reconnecting")
                    s.cancel()
                }
            }
        }
    }

    fun stop() {
        wanted = false
        loop?.cancel()
        heartbeat?.cancel()
        socket?.close(1000, "bye")
        socket = null
        _state.value = LinkState.OFFLINE
    }

    /** Reconnect now (e.g. network became available) instead of waiting out the backoff. */
    fun nudge() {
        if (!wanted || _state.value == LinkState.ONLINE) return
        loop?.cancel()
        attempt = 0
        connect()
    }

    fun send(msg: JSONObject): Boolean = socket?.send(msg.toString()) ?: false

    fun ack(ids: List<String>) = send(JSONObject().put("t", "ack").put("ids", JSONArray(ids)))
    fun read(ids: List<String>) = send(JSONObject().put("t", "read").put("ids", JSONArray(ids)))

    private fun connect(forceRefresh: Boolean = false) {
        loop = scope.launch {
            if (!wanted) return@launch
            _state.value = LinkState.CONNECTING
            val token = try {
                api.accessToken(forceRefresh)
            } catch (e: ApiException) {
                if (e.status == 401) {
                    Log.w(TAG, "refresh rejected; signing out")
                    _state.value = LinkState.OFFLINE
                    onAuthRejected()
                    return@launch
                }
                scheduleReconnect(); return@launch
            } catch (e: Exception) {
                scheduleReconnect(); return@launch
            }
            val wsUrl = session.serverUrl.replaceFirst("http", "ws") + "/ws?token=$token"
            socket = api.http.newWebSocket(Request.Builder().url(wsUrl).build(), Listener())
        }
    }

    private fun scheduleReconnect(forceRefresh: Boolean = false) {
        socket = null
        if (!wanted) return
        _state.value = LinkState.OFFLINE
        val delayMs = min(30_000L, 1000L shl min(attempt, 5))
        attempt++
        loop = scope.launch {
            delay(delayMs)
            connect(forceRefresh)
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            lastMessageAt = System.currentTimeMillis()
            _state.value = LinkState.ONLINE
            webSocket.send("""{"t":"hello"}""")
            onConnected()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            lastMessageAt = System.currentTimeMillis()
            runCatching { onMessage(JSONObject(text)) }.onFailure { Log.e(TAG, "bad message", it) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket === socket) scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket !== socket) return
            Log.w(TAG, "socket failure: ${t.message} (${response?.code})")
            scheduleReconnect(forceRefresh = response?.code == 401)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    companion object {
        private const val TAG = "Realtime"
    }
}
