package com.tactical.seccam.ui.components

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.tactical.seccam.data.DetectionEventItem
import com.tactical.seccam.data.Repository
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Share an event's clip (or its detection frame when there is no clip) through the
 * system share sheet. The file is downloaded into the app cache and handed out via a
 * FileProvider grant, so the receiving app never sees the server URL or a token.
 */
suspend fun shareEventMedia(context: Context, repo: Repository, ev: DetectionEventItem, clip: Boolean) {
    val url = (if (clip) ev.clipUrl else ev.imageUrl) ?: error(if (clip) "Clip not ready" else "No frame")
    val dir = File(context.cacheDir, "shared")
    // Old shares are no longer needed by the receiving app after a day.
    dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
    val cam = ev.cameraName.replace(Regex("[^A-Za-z0-9]+"), "-").trim('-').lowercase().ifBlank { "camera" }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(ev.createdAt))
    val file = File(dir, "apex-$cam-${ev.kind}-$stamp.${if (clip) "mp4" else "jpg"}")
    if (!file.exists() || file.length() == 0L) repo.api.download(url, file)

    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val what = "${Fmt.kind(ev.kind).lowercase().replaceFirstChar { it.uppercase() }} detected · ${ev.cameraName} · ${Fmt.stamp(ev.createdAt)}"
    val send = Intent(Intent.ACTION_SEND)
        .setType(if (clip) "video/mp4" else "image/jpeg")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .putExtra(Intent.EXTRA_SUBJECT, what)
        .putExtra(Intent.EXTRA_TEXT, what)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    send.clipData = ClipData.newRawUri(file.name, uri)
    context.startActivity(Intent.createChooser(send, if (clip) "Share clip" else "Share frame"))
}
