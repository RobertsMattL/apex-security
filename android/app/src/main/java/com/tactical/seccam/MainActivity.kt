package com.tactical.seccam

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.screens.AlertsScreen
import com.tactical.seccam.ui.screens.CameraDetailScreen
import com.tactical.seccam.ui.screens.CameraSetupScreen
import com.tactical.seccam.ui.screens.DashboardScreen
import com.tactical.seccam.ui.screens.EventDetailScreen
import com.tactical.seccam.ui.screens.LoginScreen
import com.tactical.seccam.ui.screens.SystemScreen
import com.tactical.seccam.ui.theme.TacticalTheme

/** Destinations. Kept as simple strings so the back stack survives configuration changes. */
private sealed interface Dest {
    data object Dashboard : Dest
    data object Alerts : Dest
    data object AddCamera : Dest
    data object System : Dest
    data class Camera(val id: String) : Dest
    data class Event(val eventId: String, val alertId: String?) : Dest

    fun encode(): String = when (this) {
        Dashboard -> "dash"; Alerts -> "alerts"; AddCamera -> "add"; System -> "sys"
        is Camera -> "cam:$id"; is Event -> "ev:$eventId:${alertId ?: ""}"
    }

    companion object {
        fun decode(s: String): Dest = when {
            s == "alerts" -> Alerts; s == "add" -> AddCamera; s == "sys" -> System
            s.startsWith("cam:") -> Camera(s.removePrefix("cam:"))
            s.startsWith("ev:") -> s.split(":").let { Event(it[1], it.getOrNull(2)?.ifBlank { null }) }
            else -> Dashboard
        }
    }
}

class MainActivity : ComponentActivity() {
    private val pendingAlert = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        pendingAlert.value = intent.getStringExtra(EXTRA_ALERT_ID)
        val repo = (application as SecCamApp).repo
        setContent { TacticalTheme { AppRoot(repo, pendingAlert.value) { pendingAlert.value = null } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_ALERT_ID)?.let { pendingAlert.value = it }
    }

    companion object {
        const val EXTRA_ALERT_ID = "alertId"
    }
}

@Composable
private fun AppRoot(repo: Repository, openAlert: String?, onAlertOpened: () -> Unit) {
    val signedIn by repo.signedIn.collectAsStateWithLifecycle()

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(signedIn) {
        if (signedIn && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    if (!signedIn) {
        LoginScreen(repo)
        return
    }

    var saved by rememberSaveable { mutableStateOf(listOf("dash")) }
    val stack = remember { mutableStateListOf<Dest>().apply { addAll(saved.map(Dest::decode)) } }
    fun sync() { saved = stack.map { it.encode() } }
    fun push(d: Dest) { stack.add(d); sync() }
    fun pop() { if (stack.size > 1) { stack.removeAt(stack.lastIndex); sync() } }
    fun replaceTop(d: Dest) { stack[stack.lastIndex] = d; sync() }

    // Tapping a system notification lands on that event.
    LaunchedEffect(openAlert) {
        val a = openAlert?.let { repo.alerts.get(it) }
        if (openAlert != null) {
            if (a != null) {
                repo.setEventSequence(repo.alerts.alerts.value.map { com.tactical.seccam.data.EventRef(it.eventId, it.id) })
                push(Dest.Event(a.eventId, a.id))
            } else push(Dest.Alerts)
            onAlertOpened()
        }
    }

    BackHandler(stack.size > 1) { pop() }

    AnimatedContent(stack.last(), transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "nav") { dest ->
        when (dest) {
            Dest.Dashboard -> DashboardScreen(
                repo,
                onCamera = { push(Dest.Camera(it)) },
                onAddCamera = { push(Dest.AddCamera) },
                onAlerts = { push(Dest.Alerts) },
                onEvent = { push(Dest.Event(it, null)) },
                onSettings = { push(Dest.System) },
            )
            Dest.Alerts -> AlertsScreen(repo, onBack = ::pop, onOpen = { push(Dest.Event(it.eventId, it.id)) })
            Dest.AddCamera -> CameraSetupScreen(repo, onBack = ::pop, onCreated = { replaceTop(Dest.Camera(it)) })
            Dest.System -> SystemScreen(repo, onBack = ::pop)
            is Dest.Camera -> CameraDetailScreen(repo, dest.id, onBack = ::pop, onEvent = { push(Dest.Event(it, null)) })
            is Dest.Event -> EventDetailScreen(repo, dest.eventId, dest.alertId, onBack = ::pop, onLive = { push(Dest.Camera(it)) })
        }
    }
}
