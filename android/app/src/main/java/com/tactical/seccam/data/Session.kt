package com.tactical.seccam.data

import android.content.Context

/** Server address and device credentials, in app-private storage. */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(v) = prefs.edit().putString("serverUrl", v.trimEnd('/')).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(v) = prefs.edit().putString("username", v).apply()

    var accessToken: String?
        get() = prefs.getString("accessToken", null)
        set(v) = prefs.edit().putString("accessToken", v).apply()

    var refreshToken: String?
        get() = prefs.getString("refreshToken", null)
        set(v) = prefs.edit().putString("refreshToken", v).apply()

    var deviceId: String?
        get() = prefs.getString("deviceId", null)
        set(v) = prefs.edit().putString("deviceId", v).apply()

    val signedIn get() = serverUrl.isNotBlank() && refreshToken != null

    fun clearTokens() {
        prefs.edit().remove("accessToken").remove("refreshToken").apply()
    }
}
