package com.tactical.seccam.ui.components

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object Fmt {
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)
    private val day = SimpleDateFormat("EEE dd MMM yyyy", Locale.US)
    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

    fun clock(ms: Long): String = clock.format(Date(ms))
    fun stamp(ms: Long): String = stamp.format(Date(ms))

    fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
        val s = ((now - ms) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "${s}s ago"
            s < 3600 -> "${s / 60}m ago"
            s < 86400 -> "${s / 3600}h ago"
            else -> "${s / 86400}d ago"
        }
    }

    fun dayHeader(ms: Long): String {
        val c = Calendar.getInstance().apply { timeInMillis = ms }
        val today = Calendar.getInstance()
        val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        fun same(a: Calendar, b: Calendar) = a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
        return when {
            same(c, today) -> "TODAY"
            same(c, yesterday) -> "YESTERDAY"
            else -> day.format(Date(ms)).uppercase()
        }
    }

    fun pct(conf: Double) = "${(conf * 100).toInt()}%"
    fun secs(s: Double?) = if (s == null) "—" else "${Math.round(s)}s"
    fun mmss(ms: Long) = "%d:%02d".format(ms / 60000, (ms / 1000) % 60)

    fun kind(kind: String) = when (kind) {
        "person" -> "HUMAN"
        "animal" -> "ANIMAL"
        else -> kind.uppercase()
    }
}
