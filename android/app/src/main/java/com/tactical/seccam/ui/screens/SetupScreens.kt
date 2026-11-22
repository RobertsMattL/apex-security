package com.tactical.seccam.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tactical.seccam.data.ProbeResult
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.FullScreen
import com.tactical.seccam.ui.components.GlassPanel
import com.tactical.seccam.ui.components.KeyValue
import com.tactical.seccam.ui.components.LinkIndicator
import com.tactical.seccam.ui.components.SectionHeader
import com.tactical.seccam.ui.components.Segmented
import com.tactical.seccam.ui.components.StatusPip
import com.tactical.seccam.ui.components.TacButton
import com.tactical.seccam.ui.components.TacField
import com.tactical.seccam.ui.components.ToggleRow
import com.tactical.seccam.ui.components.TopBar
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.launch

/** Add-camera wizard: source → auth → link test → identify → listeners → deploy. */
@Composable
fun CameraSetupScreen(repo: Repository, onBack: () -> Unit, onCreated: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("rtsp://") }
    var transport by remember { mutableStateOf("automatic") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var person by remember { mutableStateOf(true) }
    var animal by remember { mutableStateOf(false) }
    var probe by remember { mutableStateOf<ProbeResult?>(null) }
    var testing by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Any change to the source invalidates the previous test.
    LaunchedEffect(url, user, pass, transport) { probe = null }

    val urlOk = url.matches(Regex("^rtsps?://[^/\\s]+.*"))
    val tested = probe?.ok == true
    val step = when {
        !urlOk -> 1
        !tested -> 3
        name.isBlank() -> 4
        else -> 5
    }

    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar("Add camera", subtitle = "DEPLOY NEW SENSOR", onBack = onBack)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().navigationBarsPadding().padding(horizontal = 14.dp)) {
                StepRail(step)

                SectionHeader("01 · Source")
                GlassPanel(Modifier.fillMaxWidth()) {
                    TacField("RTSP URL", url, { url = it.trim() }, placeholder = "rtsp://192.168.1.50:554/stream1", keyboard = KeyboardType.Uri)
                    Text("Credentials in the URL are moved to secure server storage.", style = Tac.DataSmall.copy(color = Tac.TextFaint))
                    Spacer(Modifier.height(10.dp))
                    Text("TRANSPORT", style = Tac.Label)
                    Spacer(Modifier.height(6.dp))
                    Segmented(listOf("automatic" to "AUTO", "tcp" to "TCP", "udp" to "UDP"), transport) { transport = it }
                }

                SectionHeader("02 · Authentication")
                GlassPanel(Modifier.fillMaxWidth()) {
                    Text("Optional. Stored encrypted on the server, never sent back to devices.", style = Tac.DataSmall.copy(color = Tac.TextFaint))
                    TacField("Username", user, { user = it })
                    TacField("Password", pass, { pass = it }, password = true)
                }

                SectionHeader("03 · Link test")
                GlassPanel(Modifier.fillMaxWidth(), accent = when (probe?.ok) { true -> Tac.Green; false -> Tac.Red; null -> null }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TacButton(if (testing) "Testing…" else "Run test", {
                            scope.launch {
                                testing = true; error = null
                                probe = runCatching { repo.api.testCamera(url, user, pass, transport) }.getOrElse { ProbeResult(false, it.message, null, 0) }
                                testing = false
                            }
                        }, enabled = urlOk && !testing, primary = !tested)
                        if (testing) StatusPip(Tac.Amber, pulse = true)
                    }
                    probe?.let { p ->
                        Spacer(Modifier.height(10.dp))
                        if (p.ok) {
                            KeyValue("Result", "SIGNAL ACQUIRED", Tac.Green)
                            KeyValue("Video", p.summary ?: "—")
                            KeyValue("Latency", "${p.latencyMs} ms")
                        } else {
                            KeyValue("Result", "NO SIGNAL", Tac.Red)
                            Text(p.error ?: "unknown error", style = Tac.DataSmall.copy(color = Tac.Red))
                        }
                    }
                }

                SectionHeader("04 · Identify")
                GlassPanel(Modifier.fillMaxWidth()) {
                    TacField("Camera name", name, { name = it.take(64) }, placeholder = "Driveway")
                }

                SectionHeader("05 · Detection listeners")
                GlassPanel(Modifier.fillMaxWidth()) {
                    ToggleRow("Human detection", "Alert when a person is detected", person, { person = it }, accent = Tac.Red)
                    ToggleRow("Animal detection", "Dogs, cats, birds, wildlife", animal, { animal = it }, accent = Tac.Amber)
                    Text("Thresholds and cooldowns can be tuned per camera after deployment.", style = Tac.DataSmall.copy(color = Tac.TextFaint))
                }

                AnimatedVisibility(error != null) { Text(error ?: "", style = Tac.DataSmall.copy(color = Tac.Red), modifier = Modifier.padding(top = 10.dp)) }
                Spacer(Modifier.height(16.dp))
                TacButton(
                    if (creating) "Deploying…" else "Deploy camera",
                    onClick = {
                        scope.launch {
                            creating = true; error = null
                            runCatching {
                                val cam = repo.api.createCamera(name.trim(), url, user, pass, transport)
                                val listeners = cam.listeners.map { l ->
                                    when (l.kind) { "person" -> l.copy(enabled = person); "animal" -> l.copy(enabled = animal); else -> l }
                                }
                                repo.api.updateSettings(cam.id, null, listeners)
                                repo.upsertCamera(repo.api.camera(cam.id))
                                cam.id
                            }.onSuccess(onCreated).onFailure { error = it.message }
                            creating = false
                        }
                    },
                    enabled = tested && name.isNotBlank() && !creating,
                    primary = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(40.dp))
            }
        }
    }
}

@Composable
private fun StepRail(step: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf("SRC", "AUTH", "TEST", "ID", "DET").forEachIndexed { i, label ->
            val n = i + 1
            val c = when { n < step -> Tac.Green; n == step -> Tac.Cyan; else -> Tac.TextFaint }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(8.dp).background(c))
                Text(label, style = Tac.DataSmall.copy(color = c), modifier = Modifier.padding(top = 4.dp))
            }
            if (i < 4) Box(Modifier.weight(1f).padding(horizontal = 6.dp).height(1.dp).background(if (n < step) Tac.Green.copy(alpha = 0.5f) else Tac.Hairline))
        }
    }
}

/** System panel: link status, device identity, sign-out. */
@Composable
fun SystemScreen(repo: Repository, onBack: () -> Unit) {
    val link by repo.link.collectAsStateWithLifecycle()
    val cams by repo.cameras.collectAsStateWithLifecycle()
    FullScreen {
        Column(Modifier.fillMaxSize()) {
            TopBar("System", subtitle = "CONSOLE STATUS", onBack = onBack)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 14.dp)) {
                SectionHeader("Uplink")
                GlassPanel(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Text("WEBSOCKET", style = Tac.Label, modifier = Modifier.width(112.dp)); LinkIndicator(link) }
                    KeyValue("Server", repo.session.serverUrl)
                    KeyValue("Operator", repo.session.username)
                    KeyValue("Device", (repo.session.deviceId ?: "—").take(8).uppercase())
                    KeyValue("Cameras", "${cams.size}")
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        TacButton("Reconnect", { repo.realtime.nudge() })
                    }
                }
                SectionHeader("Session")
                TacButton("Sign out", { repo.signOut() }, accent = Tac.Red)
                Spacer(Modifier.height(30.dp))
                Text("Alerts are delivered over a persistent connection kept alive by a foreground service. Each alert is acknowledged on receipt and marked read when opened; the server retries until it hears back.", style = Tac.Body.copy(color = Tac.TextFaint))
                Spacer(Modifier.height(30.dp))
            }
        }
    }
}
