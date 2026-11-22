package com.tactical.seccam.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tactical.seccam.data.Repository
import com.tactical.seccam.ui.components.FullScreen
import com.tactical.seccam.ui.components.GlassPanel
import com.tactical.seccam.ui.components.StatusPip
import com.tactical.seccam.ui.components.TacButton
import com.tactical.seccam.ui.components.TacField
import com.tactical.seccam.ui.components.cornerBrackets
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.launch

/** Pair this device with a server. First run on a fresh server creates the admin account. */
@Composable
fun LoginScreen(repo: Repository) {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(repo.session.serverUrl.ifBlank { "http://192.168.1.10:8780" }) }
    var user by remember { mutableStateOf(repo.session.username.ifBlank { "admin" }) }
    var pass by remember { mutableStateOf("") }
    var setupRequired by remember { mutableStateOf<Boolean?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun probe() = scope.launch {
        busy = true; error = null; status = null
        runCatching { repo.api.health(normalize(server)) }
            .onSuccess { setupRequired = it.optBoolean("setupRequired"); status = if (setupRequired == true) "SERVER FOUND · FIRST RUN" else "SERVER FOUND" }
            .onFailure { setupRequired = null; error = "Server unreachable: ${it.message}" }
        busy = false
    }

    FullScreen {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(48.dp))
            Box(Modifier.size(72.dp).cornerBrackets(Tac.Cyan, 18.dp, 2.dp), contentAlignment = Alignment.Center) {
                StatusPip(Tac.Amber, pulse = true, size = 8.dp)
            }
            Spacer(Modifier.height(18.dp))
            Text("APEX SECURITY", style = Tac.Headline)
            Text("SURVEILLANCE CONSOLE · LINK SETUP", style = Tac.Label)
            Spacer(Modifier.height(32.dp))

            GlassPanel(Modifier.fillMaxWidth().widthIn(max = 460.dp), accent = Tac.Cyan.copy(alpha = 0.6f), padding = 18.dp) {
                Text("// UPLINK", style = Tac.Label.copy(color = Tac.Cyan))
                TacField("Server address", server, { server = it; setupRequired = null; status = null }, placeholder = "http://192.168.1.10:8780", keyboard = KeyboardType.Uri)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TacButton("Probe", { probe() }, enabled = !busy)
                    status?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.Green)) }
                }
                Spacer(Modifier.height(10.dp))
                Text(if (setupRequired == true) "// CREATE ADMIN ACCOUNT" else "// OPERATOR", style = Tac.Label.copy(color = if (setupRequired == true) Tac.Amber else Tac.Cyan))
                TacField("Username", user, { user = it })
                TacField("Password", pass, { pass = it }, password = true, placeholder = if (setupRequired == true) "min. 8 characters" else "")
                error?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.Red), modifier = Modifier.padding(vertical = 6.dp)) }
                Spacer(Modifier.height(8.dp))
                TacButton(
                    if (setupRequired == true) "Create & connect" else "Connect",
                    onClick = {
                        scope.launch {
                            busy = true; error = null
                            runCatching { repo.signIn(normalize(server), user.trim(), pass, createAccount = setupRequired == true) }
                                .onFailure { error = it.message ?: "sign-in failed" }
                            busy = false
                        }
                    },
                    enabled = !busy && user.isNotBlank() && pass.isNotBlank() && server.isNotBlank(),
                    primary = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "Run the server on your LAN and enter its address. Camera credentials stay on the server; this device only receives short-lived stream tokens.",
                style = Tac.Body.copy(color = Tac.TextFaint),
                modifier = Modifier.widthIn(max = 460.dp),
            )
        }
    }
}

private fun normalize(s: String) = s.trim().trimEnd('/').let { if (it.startsWith("http://") || it.startsWith("https://")) it else "http://$it" }
