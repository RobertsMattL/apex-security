package com.tactical.seccam.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Tactical black-glass palette. Accents are used sparingly and always mean something. */
object Tac {
    val Void = Color(0xFF040608)
    val Bg = Color(0xFF07090B)
    val Charcoal = Color(0xFF0D1114)
    val Raised = Color(0xFF12171B)
    val GlassTop = Color(0x14FFFFFF)
    val GlassBottom = Color(0x05FFFFFF)
    val Hairline = Color(0xFF263038)
    val HairlineDim = Color(0xFF161C21)
    val Grid = Color(0x0F38E1FF)

    val Text = Color(0xFFE4ECF1)
    val TextDim = Color(0xFF8A97A2)
    val TextFaint = Color(0xFF4F5B65)

    /** Primary / interactive / live. */
    val Cyan = Color(0xFF38E1FF)
    /** Healthy / online. */
    val Green = Color(0xFF3DFFA2)
    /** Attention: unread, connecting, animals. */
    val Amber = Color(0xFFFFB020)
    /** Threat: human detections, failures. */
    val Red = Color(0xFFFF4D5E)

    fun kindColor(kind: String) = when (kind) {
        "person" -> Red
        "animal" -> Amber
        else -> Cyan
    }

    val Mono = FontFamily.Monospace

    /** Small caps labels: `// CAMERAS`, field captions, chips. */
    val Label = TextStyle(fontFamily = Mono, fontSize = 10.sp, letterSpacing = 1.6.sp, fontWeight = FontWeight.Medium, color = TextDim)
    /** Dense telemetry values. */
    val Data = TextStyle(fontFamily = Mono, fontSize = 12.sp, letterSpacing = 0.4.sp, color = Text)
    val DataSmall = TextStyle(fontFamily = Mono, fontSize = 10.sp, letterSpacing = 0.6.sp, color = TextDim)
    val Title = TextStyle(fontFamily = Mono, fontSize = 15.sp, letterSpacing = 2.4.sp, fontWeight = FontWeight.SemiBold, color = Text)
    val Headline = TextStyle(fontFamily = Mono, fontSize = 20.sp, letterSpacing = 3.sp, fontWeight = FontWeight.Bold, color = Text)
    val Body = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, color = Text)
    val Metric = TextStyle(fontFamily = Mono, fontSize = 22.sp, fontWeight = FontWeight.Light, letterSpacing = 1.sp, color = Text)
}

@Composable
fun TacticalTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tac.Cyan,
            onPrimary = Tac.Void,
            secondary = Tac.Green,
            tertiary = Tac.Amber,
            background = Tac.Bg,
            onBackground = Tac.Text,
            surface = Tac.Charcoal,
            onSurface = Tac.Text,
            surfaceVariant = Tac.Raised,
            onSurfaceVariant = Tac.TextDim,
            outline = Tac.Hairline,
            outlineVariant = Tac.HairlineDim,
            error = Tac.Red,
        ),
        content = content,
    )
}
